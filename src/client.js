/**
 * WindsurfClient — talks to the local language server binary via gRPC (HTTP/2).
 *
 * Two flows:
 *   Legacy  → RawGetChatMessage (streaming, for enum-only models)
 *   Cascade → StartCascade → SendUserCascadeMessage → poll (for modelUid models)
 */

import https from 'https';
import { randomUUID } from 'crypto';
import { log } from './config.js';
import { extractImages } from './image.js';
import { grpcFrame, grpcUnary, grpcStream } from './grpc.js';
import { getLsEntryByPort } from './langserver.js';
import {
  buildRawGetChatMessageRequest, parseRawResponse,
  buildInitializePanelStateRequest,
  buildAddTrackedWorkspaceRequest,
  buildUpdateWorkspaceTrustRequest,
  buildStartCascadeRequest, parseStartCascadeResponse,
  buildSendCascadeMessageRequest,
  buildGetTrajectoryRequest, parseTrajectoryStatus,
  buildGetTrajectoryStepsRequest, parseTrajectorySteps,
  buildGetGeneratorMetadataRequest, parseGeneratorMetadata,
} from './windsurf.js';

const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// ─── WindsurfClient ────────────────────────────────────────

export class WindsurfClient {
  /**
   * @param {string} apiKey - Codeium API key
   * @param {number} port - Language server gRPC port
   * @param {string} csrfToken - CSRF token for auth
   */
  constructor(apiKey, port, csrfToken) {
    this.apiKey = apiKey;
    this.port = port;
    this.csrfToken = csrfToken;
  }

  // ─── Legacy: RawGetChatMessage (streaming) ───────────────

  /**
   * Stream chat via RawGetChatMessage.
   * Used for models without a string UID (enum < 280 generally).
   *
   * @param {Array} messages - OpenAI-format messages
   * @param {number} modelEnum - Model enum value
   * @param {string} [modelName] - Optional model name
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  rawGetChatMessage(messages, modelEnum, modelName, opts = {}) {
    const { onChunk, onEnd, onError } = opts;
    const proto = buildRawGetChatMessageRequest(this.apiKey, messages, modelEnum, modelName);
    const body = grpcFrame(proto);

    log.debug(`RawGetChatMessage: enum=${modelEnum} msgs=${messages.length}`);

    return new Promise((resolve, reject) => {
      const chunks = [];

      grpcStream(this.port, this.csrfToken, `${LS_SERVICE}/RawGetChatMessage`, body, {
        onData: (payload) => {
          try {
            const parsed = parseRawResponse(payload);
            if (parsed.text) {
              // Detect server-side errors returned as text
              const errMatch = /^(permission_denied|failed_precondition|not_found|unauthenticated):/.test(parsed.text.trim());
              if (parsed.isError || errMatch) {
                const err = new Error(parsed.text.trim());
                // Mark model-level errors so they don't count against the account
                err.isModelError = /permission_denied|failed_precondition/.test(parsed.text);
                reject(err);
                return;
              }
              chunks.push(parsed);
              onChunk?.(parsed);
            }
          } catch (e) {
            log.error('RawGetChatMessage parse error:', e.message);
          }
        },
        onEnd: () => {
          onEnd?.(chunks);
          resolve(chunks);
        },
        onError: (err) => {
          onError?.(err);
          reject(err);
        },
      });
    });
  }

  /**
   * Run (or wait for) the one-shot Cascade workspace init for this LS.
   * Idempotent — the LS entry caches the in-flight Promise so concurrent
   * callers share one init round. Safe to call from a startup warmup path
   * so the first real chat request skips these 3 gRPC round-trips.
   */
  warmupCascade(force = false) {
    const lsEntry = getLsEntryByPort(this.port);
    if (!lsEntry) return Promise.resolve();
    if (force) {
      lsEntry.workspaceInit = null;
      lsEntry.sessionId = randomUUID();
    }
    if (!lsEntry.sessionId) lsEntry.sessionId = randomUUID();
    if (lsEntry.workspaceInit) return lsEntry.workspaceInit;

    const sessionId = lsEntry.sessionId;
    const workspacePath = '/tmp/windsurf-workspace';
    const workspaceUri = 'file:///tmp/windsurf-workspace';

    lsEntry.workspaceInit = (async () => {
      try {
        const initProto = buildInitializePanelStateRequest(this.apiKey, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/InitializeCascadePanelState`, grpcFrame(initProto), 5000);
      } catch (e) { log.warn(`InitializeCascadePanelState: ${e.message}`); }
      try {
        const addWsProto = buildAddTrackedWorkspaceRequest(this.apiKey, workspacePath, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/AddTrackedWorkspace`, grpcFrame(addWsProto), 5000);
      } catch (e) { log.warn(`AddTrackedWorkspace: ${e.message}`); }
      try {
        const trustProto = buildUpdateWorkspaceTrustRequest(this.apiKey, workspaceUri, true, sessionId);
        await grpcUnary(this.port, this.csrfToken,
          `${LS_SERVICE}/UpdateWorkspaceTrust`, grpcFrame(trustProto), 5000);
      } catch (e) { log.warn(`UpdateWorkspaceTrust: ${e.message}`); }
      log.info(`Cascade workspace init complete for LS port=${this.port}`);
    })().catch(e => {
      lsEntry.workspaceInit = null;
      throw e;
    });
    return lsEntry.workspaceInit;
  }

  // ─── Cascade flow ────────────────────────────────────────

  /**
   * Chat via Cascade flow (for premium models with string UIDs).
   *
   * 1. StartCascade → cascade_id
   * 2. SendUserCascadeMessage (with model config)
   * 3. Poll GetCascadeTrajectorySteps until IDLE
   *
   * @param {Array} messages
   * @param {number} modelEnum
   * @param {string} modelUid
   * @param {object} opts - { onChunk, onEnd, onError }
   */
  async cascadeChat(messages, modelEnum, modelUid, opts = {}) {
    const { onChunk, onEnd, onError, signal, reuseEntry, toolPreamble } = opts;
    const aborted = () => signal?.aborted;
    const inputChars = messages.reduce((n, m) => n + contentToString(m?.content).length, 0);

    log.debug(`CascadeChat: uid=${modelUid} enum=${modelEnum} msgs=${messages.length} reuse=${!!reuseEntry}`);

    // One-shot per-LS workspace init (idempotent; typically pre-warmed at
    // LS startup). Falls back to a local session id if the LS entry is gone.
    const lsEntry = getLsEntryByPort(this.port);
    await this.warmupCascade().catch(() => {});
    let sessionId = reuseEntry?.sessionId || lsEntry?.sessionId || randomUUID();

    // "panel state not found" means the LS forgot the panel for our sessionId
    // (LS restarted, TTL expired, etc.). Re-run warmupCascade with a fresh
    // sessionId and retry the handshake once.
    const isPanelMissing = (e) => /panel state not found|not_found.*panel/i.test(e?.message || '');

    try {
      // Step 1: Start cascade — with retry on panel-state-not-found
      let cascadeId;
      const openCascade = async () => {
        if (reuseEntry?.cascadeId) {
          log.debug(`Cascade resumed: ${reuseEntry.cascadeId}`);
          return reuseEntry.cascadeId;
        }
        const startProto = buildStartCascadeRequest(this.apiKey, sessionId);
        const startResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/StartCascade`, grpcFrame(startProto)
        );
        const id = parseStartCascadeResponse(startResp);
        if (!id) throw new Error('StartCascade returned empty cascade_id');
        log.debug(`Cascade started: ${id}`);
        return id;
      };
      try {
        cascadeId = await openCascade();
      } catch (e) {
        if (!isPanelMissing(e)) throw e;
        log.warn(`Panel state missing, re-warming LS port=${this.port}`);
        await this.warmupCascade(true).catch(() => {});
        sessionId = getLsEntryByPort(this.port)?.sessionId || randomUUID();
        if (reuseEntry) reuseEntry.cascadeId = null; // force StartCascade
        cascadeId = await openCascade();
      }

      // Build the text payload. Two cases:
      //   - Resuming an existing cascade: the backend already has the prior
      //     turns cached, so we only send the newest user message.
      //   - Fresh cascade: we have to pack the entire history into one shot
      //     (Cascade doesn't accept a messages array). System blocks go on
      //     top, then we render u/a turns as a labeled transcript so the
      //     model can see its own prior replies — previously we dropped
      //     assistant turns entirely and multi-turn context was broken.
      //
      // The caller (handlers/chat.js) is responsible for any tool-protocol
      // preamble that needs to sit in front of the user text (client-defined
      // OpenAI tools are serialized into a '<tool_call>{...}</tool_call>'
      // emission contract there). This function just stitches system + u/a
      // turns into the single text payload Cascade accepts.
      let text;
      let images = [];
      if (reuseEntry?.cascadeId) {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const extracted = await extractImages(lastUser?.content ?? '');
        text = extracted.text;
        images = extracted.images;
      } else {
        const systemMsgs = messages.filter(m => m.role === 'system');
        const convo = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const sysText = systemMsgs.map(m => contentToString(m.content)).join('\n').trim();

        if (convo.length <= 1) {
          const last = convo[convo.length - 1];
          const extracted = await extractImages(last?.content ?? '');
          text = extracted.text;
          images = extracted.images;
        } else {
          const lines = [];
          for (let i = 0; i < convo.length - 1; i++) {
            const m = convo[i];
            const label = m.role === 'user' ? 'User' : 'Assistant';
            lines.push(`${label}: ${contentToString(m.content)}`);
          }
          const latest = convo[convo.length - 1];
          const extracted = await extractImages(latest?.content ?? '');
          text = `[Conversation so far]\n${lines.join('\n\n')}\n\n[Current user message]\n${extracted.text}`;
          images = extracted.images;
        }
        if (sysText) text = sysText + '\n\n' + text;
      }
      if (images.length) log.info(`Cascade: attaching ${images.length} image(s) to field 6`);

      // Step 2: Send message (retry once on panel-state-not-found)
      const sendMessage = async () => {
        const sendProto = buildSendCascadeMessageRequest(this.apiKey, cascadeId, text, modelEnum, modelUid, sessionId, { toolPreamble, images });
        await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/SendUserCascadeMessage`, grpcFrame(sendProto)
        );
      };
      try {
        await sendMessage();
      } catch (e) {
        if (!isPanelMissing(e)) throw e;
        log.warn(`Panel state missing on Send, re-warming + restarting cascade port=${this.port}`);
        await this.warmupCascade(true).catch(() => {});
        sessionId = getLsEntryByPort(this.port)?.sessionId || randomUUID();
        const startProto = buildStartCascadeRequest(this.apiKey, sessionId);
        const startResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/StartCascade`, grpcFrame(startProto)
        );
        cascadeId = parseStartCascadeResponse(startResp);
        if (!cascadeId) throw new Error('StartCascade returned empty cascade_id after re-warm');
        await sendMessage();
      }

      // Step 3: Poll for response.
      // Track per-step text cursors instead of a single global `lastYielded`.
      // The cascade trajectory can contain MULTIPLE PLANNER_RESPONSE steps
      // (thinking step + final response, or multi-turn). The old single-cursor
      // code silently dropped any step whose text was shorter than the longest
      // step seen so far — which showed up as "30k in / 200 out" where the real
      // answer was split across two steps and only one was emitted.
      const chunks = [];
      const yieldedByStep = new Map(); // stepIndex → emitted text length
      const thinkingByStep = new Map(); // stepIndex → emitted thinking length
      // Server-reported token usage, one entry per step keyed by step index.
      // Each value is the latest {inputTokens, outputTokens, cacheReadTokens,
      // cacheWriteTokens} observed on that step's CortexStepMetadata.model_usage.
      // Summed across all steps at return time → the response's real usage.
      const usageByStep = new Map();
      const seenToolCallIds = new Set();
      const toolCalls = [];
      let totalYielded = 0;
      let totalThinking = 0;
      let pollCount = 0;
      let sawActive = false;   // true once we've seen a non-IDLE status
      let sawText = false;     // true once at least one PLANNER_RESPONSE with text arrived
      let lastStatus = -1;
      let lastStepCount = 0;
      const pollInterval = 250;
      const startTime = Date.now();
      let endReason = 'unknown';

      while (true) {
        if (aborted()) { endReason = 'aborted'; break; }
        await new Promise(r => setTimeout(r, pollInterval));
        if (aborted()) { endReason = 'aborted'; break; }
        pollCount++;

        const stepsProto = buildGetTrajectoryStepsRequest(cascadeId, 0);
        const stepsResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
        );
        const steps = parseTrajectorySteps(stepsResp);

        // CORTEX_STEP_TYPE_ERROR_MESSAGE = 17. An error step means the cascade
        // refused the request (permission denied, model unavailable, etc.) —
        // raise it as a model-level error so the account isn't blamed.
        for (const step of steps) {
          if (step.type === 17 && step.errorText) {
            const trail = steps.map(s => ({
              type: s.type,
              status: s.status,
              textLen: s.text?.length || 0,
              tools: (s.toolCalls || []).map(tc => tc.name).join(','),
            }));
            log.warn('Cascade error step', { errorText: step.errorText.trim(), trail });
            const err = new Error(step.errorText.trim());
            err.isModelError = true;
            throw err;
          }
        }

        if (steps.length > lastStepCount) lastStepCount = steps.length;

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];

          if (step.usage) usageByStep.set(i, step.usage);

          if (step.toolCalls && step.toolCalls.length) {
            for (const tc of step.toolCalls) {
              const key = tc.id || `${tc.name}:${tc.argumentsJson}`;
              if (seenToolCallIds.has(key)) continue;
              seenToolCallIds.add(key);
              toolCalls.push(tc);
            }
          }

          // Thinking delta: emit newly appended reasoning text only.
          const liveThink = step.thinking || '';
          if (liveThink) {
            const prevThink = thinkingByStep.get(i) || 0;
            if (liveThink.length > prevThink) {
              const thinkDelta = liveThink.slice(prevThink);
              thinkingByStep.set(i, liveThink.length);
              totalThinking += thinkDelta.length;
              const tchunk = { text: '', thinking: thinkDelta, isError: false };
              chunks.push(tchunk);
              onChunk?.(tchunk);
            }
          }

          // Text delta rule: prefer responseText (append-only stream) while
          // streaming, then top up with modifiedText once IDLE is reached.
          const liveText = step.responseText || step.text || '';
          if (!liveText) continue;
          const prev = yieldedByStep.get(i) || 0;
          if (liveText.length > prev) {
            const delta = liveText.slice(prev);
            yieldedByStep.set(i, liveText.length);
            totalYielded += delta.length;
            sawText = true;
            const chunk = { text: delta, thinking: '', isError: false };
            chunks.push(chunk);
            onChunk?.(chunk);
          }
        }

        const statusProto = buildGetTrajectoryRequest(cascadeId);
        const statusResp = await grpcUnary(
          this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectory`, grpcFrame(statusProto)
        );
        const status = parseTrajectoryStatus(statusResp);
        lastStatus = status;
        if (status !== 1) sawActive = true;

        if (status === 1) {
          const finalResp = await grpcUnary(
            this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto)
          );
          const finalSteps = parseTrajectorySteps(finalResp);
          for (let i = 0; i < finalSteps.length; i++) {
            const step = finalSteps[i];
            const responseText = step.responseText || '';
            const modifiedText = step.modifiedText || '';
            const prev = yieldedByStep.get(i) || 0;

            if (responseText.length > prev) {
              const delta = responseText.slice(prev);
              yieldedByStep.set(i, responseText.length);
              totalYielded += delta.length;
              chunks.push({ text: delta, thinking: '', isError: false });
              onChunk?.({ text: delta, thinking: '', isError: false });
            }

            // Modified-response top-up: if the LS post-pass produced a longer
            // final text, emit the unseen tail even when it rewrote earlier
            // bytes instead of strictly extending responseText.
            const cursor = yieldedByStep.get(i) || 0;
            if (modifiedText.length > cursor) {
              const delta = modifiedText.slice(cursor);
              yieldedByStep.set(i, modifiedText.length);
              totalYielded += delta.length;
              chunks.push({ text: delta, thinking: '', isError: false });
              onChunk?.({ text: delta, thinking: '', isError: false });
            }
          }
          endReason = sawText ? 'idle_done' : 'idle_empty';
          break;
        }
      }

      // Structured summary so we can diagnose short/empty completions after
      // the fact. sawActive=false + sawText=false + idle_empty = the planner
      // never actually ran on this cascade — likely an upstream starvation.
      const summary = {
        cascadeId: cascadeId.slice(0, 8),
        reason: endReason,
        polls: pollCount,
        textLen: totalYielded,
        thinkingLen: totalThinking,
        stepCount: Math.max(yieldedByStep.size, thinkingByStep.size, lastStepCount),
        toolCalls: seenToolCallIds.size,
        sawActive,
        sawText,
        lastStatus,
        ms: Date.now() - startTime,
      };
      if (totalYielded < 20 && endReason !== 'aborted') {
        log.warn('Cascade short reply', summary);
      } else {
        log.info('Cascade done', summary);
      }

      onEnd?.(chunks);

      // ── Real token usage via GetCascadeTrajectoryGeneratorMetadata ──
      // CortexStepMetadata.model_usage (the per-step field) is usually empty
      // in the step trajectory response — the LS only populates the real
      // token counts in a separate RPC keyed off cascade_id. We fire this
      // once after the polling loop ends. Keep it non-fatal: a network blip
      // here just drops usage back to the chars/4 estimator, the response
      // itself is already formed.
      let serverUsage = null;
      try {
        const metaReq = buildGetGeneratorMetadataRequest(cascadeId, 0);
        const metaResp = await grpcUnary(
          this.port, this.csrfToken,
          `${LS_SERVICE}/GetCascadeTrajectoryGeneratorMetadata`,
          grpcFrame(metaReq), 5000
        );
        serverUsage = parseGeneratorMetadata(metaResp);
      } catch (e) {
        log.debug(`GetCascadeTrajectoryGeneratorMetadata failed: ${e.message}`);
      }
      // Fallback: if the generator metadata RPC didn't give us anything,
      // check the per-step metadata we collected during polling (some LS
      // versions do populate CortexStepMetadata.model_usage directly).
      if (!serverUsage && usageByStep.size > 0) {
        let inT = 0, outT = 0, cacheR = 0, cacheW = 0;
        for (const u of usageByStep.values()) {
          inT += u.inputTokens || 0;
          outT += u.outputTokens || 0;
          cacheR += u.cacheReadTokens || 0;
          cacheW += u.cacheWriteTokens || 0;
        }
        if (inT || outT || cacheR || cacheW) {
          serverUsage = {
            inputTokens: inT,
            outputTokens: outT,
            cacheReadTokens: cacheR,
            cacheWriteTokens: cacheW,
          };
        }
      }

      // Attach cascade metadata so the caller can check it back into the
      // conversation pool. We still return the array so existing callers
      // that iterate over it keep working.
      chunks.cascadeId = cascadeId;
      chunks.sessionId = sessionId;
      chunks.toolCalls = toolCalls;
      chunks.usage = serverUsage;
      if (serverUsage) {
        log.info(`Cascade usage: in=${serverUsage.inputTokens} out=${serverUsage.outputTokens} cache_r=${serverUsage.cacheReadTokens} cache_w=${serverUsage.cacheWriteTokens}`);
      }
      if (toolCalls.length) log.info(`Cascade tool calls: ${toolCalls.length}`, { names: toolCalls.map(t => t.name) });
      return chunks;

    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  // ─── Register user (JSON REST, unchanged) ────────────────

  async registerUser(firebaseToken) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ firebase_id_token: firebaseToken });
      const req = https.request({
        hostname: 'api.codeium.com',
        port: 443,
        path: '/register_user/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`RegisterUser failed (${res.statusCode}): ${raw}`));
              return;
            }
            if (!json.api_key) {
              reject(new Error(`RegisterUser response missing api_key: ${raw}`));
              return;
            }
            resolve({ apiKey: json.api_key, name: json.name, apiServerUrl: json.api_server_url });
          } catch {
            reject(new Error(`RegisterUser parse error: ${raw}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}
