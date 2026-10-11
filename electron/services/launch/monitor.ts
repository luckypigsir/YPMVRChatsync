import { BrowserWindow } from "electron";
import WebSocket from "ws";
import { getCurrentLyric } from "../../../utils/format";

// 配置
const ENABLE_LYRICS_TRANSLATION = true; // 开关翻译歌词

const INJECT_SCRIPT = `
(function() {
  function readPlayer() {
    const p = window.yesplaymusic && window.yesplaymusic.player;
    const t = p && p._currentTrack;
    if (!p || !t) return null;
    const artists = Array.isArray(t.ar) ? t.ar : (Array.isArray(t.artists) ? t.artists : []);
    const artist = artists.map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean).join(' / ');
    const title = String(t.name || t.title || '');
    const id = t.id != null ? String(t.id) : (title + '|' + artist);
    const progress = Number(p._progress);
    const durationMs = Number(t.dt != null ? t.dt : t.duration);
    return {
      playId: id || null,
      current: Number.isFinite(progress) ? progress : 0,
      duration: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0,
      title,
      artist,
      isPlaying: !!p._playing,
      state: p._playing ? 1 : 2,
      lastUpdate: Date.now()
    };
  }
  function update() {
    window.__NCM_PLAY_STATE__ = readPlayer();
  }
  if (window.__NCM_YPM_TIMER__) window.clearInterval(window.__NCM_YPM_TIMER__);
  update();
  window.__NCM_YPM_TIMER__ = window.setInterval(update, 300);
  window.__NCM_MONITOR_INSTALLED__ = true;
  return window.__NCM_PLAY_STATE__;
})();
`;

export interface PlayStatus {
    playId: string | null;
    current: number | null;
    cacheProgress: number | null;
    lastUpdate: number | null;
    state: number | null; // 1=playing, 2=pause
    isPlaying: boolean;
    songInfo?: SongInfo;
}

export interface LyricLine {
    time: number;
    text: string;
    translatedText?: string;
}

export interface SongInfo {
    title: string;
    artist: string;
    duration: number;
    lyrics: LyricLine[];
}

export class NeteasePlayMonitor {
    private ws: WebSocket | null = null;
    private msgId = 1;
    private pending = new Map<number, { resolve: Function; reject: Function }>();
    private sessionId: string | null = null;
    private songCache = new Map<string, SongInfo>();
    private abortController = new AbortController();
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private isManualDisconnect = false;
    private lyricRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/gm;

    constructor(
        private win: BrowserWindow,
        private ncm_port: number
    ) {}

    async connect(): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                // 使用 Chrome DevTools 的 browser WebSocket；页面 WebSocket 不支持 Target.getTargets。
                const version = await (
                    await fetch(`http://127.0.0.1:${this.ncm_port}/json/version`)
                ).json() as { webSocketDebuggerUrl?: string };
                if (!version.webSocketDebuggerUrl) {
                    throw new Error("9222 未返回 webSocketDebuggerUrl；请确认 YesPlayMusic 的远程调试端口已开启。");
                }
                console.log("[Monitor] Connecting to DevTools browser endpoint");
                this.ws = new WebSocket(version.webSocketDebuggerUrl);

                this.ws.onopen = () => {
                    console.log("[Monitor] Connected");
                    this.reconnectAttempts = 0;
                    resolve();
                };

                this.ws.onerror = (error) => {
                    console.error("[Monitor] WebSocket error:", error);
                    reject(error);
                };

                this.ws.onclose = () => {
                    console.log("[Monitor] WebSocket closed");
                    if (!this.isManualDisconnect && !this.abortController.signal.aborted) {
                        this.tryReconnect();
                    }
                };

                this.ws.onmessage = (event) => {
                    const msg = JSON.parse(event.data.toString());
                    if (msg.method === "Target.receivedMessageFromTarget") {
                        try {
                            const inner = JSON.parse(msg.params.message);
                            if (inner.id && this.pending.has(inner.id)) {
                                const { resolve, reject } = this.pending.get(inner.id)!;
                                this.pending.delete(inner.id);
                                inner.error ? reject(new Error(inner.error.message)) : resolve(inner.result);
                            }
                        } catch {}
                    } else if (msg.id && this.pending.has(msg.id) && !this.sessionId) {
                        const { resolve, reject } = this.pending.get(msg.id)!;
                        this.pending.delete(msg.id);
                        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
                    }
                };
            } catch (error) {
                reject(error);
            }
        });
    }

    private async tryReconnect(): Promise<void> {
        if (this.isManualDisconnect || this.abortController.signal.aborted) {
            return;
        }

        while (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
            console.log(
                `[Monitor] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}, delay ${delay}ms)`
            );

            await new Promise((resolve) => setTimeout(resolve, delay));

            try {
                await this.connect();
                await this.attachToOrpheusPage();
                console.log("[Monitor] Reconnected successfully");
                return;
            } catch (error) {
                console.error("[Monitor] Reconnection failed:", error);
            }
        }
        console.error(`[Monitor] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
    }

    private send(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws) return reject(new Error("Not connected"));
            const id = this.msgId++;
            this.pending.set(id, { resolve, reject });
            const msg = this.sessionId
                ? {
                      id,
                      method: "Target.sendMessageToTarget",
                      params: {
                          sessionId: this.sessionId,
                          message: JSON.stringify({ id, method, params })
                      }
                  }
                : { id, method, params };
            this.ws.send(JSON.stringify(msg));
        });
    }

    private async evaluateScript<T = any>(expression: string, returnByValue = true): Promise<T | null> {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue
        });
        return result?.result?.value ?? null;
    }

    async attachToOrpheusPage(): Promise<void> {
        const { targetInfos } = await this.send("Target.getTargets");
        const page = targetInfos.find((t: any) =>
            t.type === "page" &&
            (t.url.startsWith("http://localhost:27232/") ||
             t.url.startsWith("http://127.0.0.1:27232/") ||
             (t.title || "").includes("YesPlayMusic"))
        );
        if (!page) throw new Error("YesPlayMusic 页面未找到。请确认它已启动，并且 9222 调试端口可访问。");
        console.log("[Monitor] Found:", page.url);
        const { sessionId } = await this.send("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: false
        });
        this.sessionId = sessionId;
    }

    private parseLyric(lyricStr: string, translatedStr?: string): LyricLine[] {
        const lines: LyricLine[] = [];
        const translatedLines = new Map<number, string>();

        // 翻译
        if (translatedStr) {
            this.lyricRegex.lastIndex = 0;
            let match;
            while ((match = this.lyricRegex.exec(translatedStr)) !== null) {
                const minutes = parseInt(match[1]!);
                const seconds = parseInt(match[2]!);
                const milliseconds = parseInt(match[3]!.padEnd(3, "0"));
                const time = minutes * 60 + seconds + milliseconds / 1000;
                const text = match[4]!.trim();
                if (text) {
                    translatedLines.set(Math.round(time * 1000), text);
                }
            }
        }

        // 原文
        this.lyricRegex.lastIndex = 0;
        let match;
        while ((match = this.lyricRegex.exec(lyricStr)) !== null) {
            const minutes = parseInt(match[1]!);
            const seconds = parseInt(match[2]!);
            const milliseconds = parseInt(match[3]!.padEnd(3, "0"));
            const time = minutes * 60 + seconds + milliseconds / 1000;
            const text = match[4]!.trim();
            if (text) {
                const timeKey = Math.round(time * 1000);
                lines.push({
                    time,
                    text,
                    translatedText: translatedLines.get(timeKey)
                });
            }
        }
        return lines.sort((a, b) => a.time - b.time);
    }

    private async fetchAPI(url: string): Promise<any> {
        try {
            const res = await fetch(url, { credentials: "include" });
            return await res.json();
        } catch (e) {
            return { error: (e as Error).message };
        }
    }

    async fetchLyrics(playId: string): Promise<LyricLine[]> {
        await this.triggerLyricFetch(playId);

        // Redux Store
        const reduxLyrics = await this.fetchLyricsFromRedux();
        if (reduxLyrics && reduxLyrics.length > 0) {
            console.log("[Lyrics] From Redux Store:", reduxLyrics.length, "lines");
            return reduxLyrics;
        }

        // fallback
        console.log("[Lyrics] Fallback to API");
        const data = await this.fetchAPI(
            `https://music.163.com/api/song/lyric?id=${playId}&lv=1&tv=${ENABLE_LYRICS_TRANSLATION ? 1 : -1}`
        );

        const originalLyric = data?.lrc?.lyric || "";
        const translatedLyric = data?.tlyric?.lyric || "";

        if (!originalLyric && !translatedLyric) return [];

        if (!originalLyric && translatedLyric) {
            console.log("[Lyrics] 原文为空，使用翻译作为主歌词");
            return this.parseLyric(translatedLyric);
        }

        return this.parseLyric(originalLyric, ENABLE_LYRICS_TRANSLATION ? translatedLyric : undefined);
    }

    async triggerLyricFetch(playId: string): Promise<void> {
        // YesPlayMusic 通常没有 NCM 的 Redux Store；不存在时直接走歌词 API 回退。
        const hasReduxStore = await this.evaluateScript<boolean>("!!window.__REDUX_STORE__");
        if (!hasReduxStore) return;

        const dispatchScript = `
      (function() {
        const store = window.__REDUX_STORE__;
        if (!store) return false;
        store.dispatch({
          type: 'async:lyric/fetchLyric',
          payload: { id: '${playId}', force: true }
        });
        return true;
      })()
    `;

        await this.evaluateScript(dispatchScript);

        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const value = await this.evaluateScript<{ isLoading: boolean; hasLines: boolean }>(
                `(function() {
                const store = window.__REDUX_STORE__;
                if (!store) return null;
                const lyric = store.getState()['async:lyric'];
                return {
                  isLoading: lyric?.isLoading,
                  hasLines: (lyric?.lyricLines?.length || 0) > 0
                };
              })()`
            );

            if (value && !value.isLoading) {
                return;
            }
        }
    }

    async fetchLyricsFromRedux(): Promise<LyricLine[] | null> {
        const script = `
      (function() {
        const store = window.__REDUX_STORE__;
        if (!store) return null;

        const state = store.getState();
        const lyric = state['async:lyric'];
        if (!lyric || lyric.currentUsedLyric === 'none') return [];

        const lyricLines = lyric.lyricLines || [];
        const tlyricLines = lyric.tlyricLines || [];

        // 创建翻译映射 (时间 -> 翻译文本)
        const tMap = new Map();
        for (const t of tlyricLines) {
          if (t.lyric) tMap.set(Math.round(t.time * 1000), t.lyric);
        }

        // 合并原文和翻译
        return lyricLines
          .filter(l => l.lyric)
          .map(l => ({
            time: l.time,
            text: l.lyric,
            translatedText: tMap.get(Math.round(l.time * 1000)) || undefined
          }));
      })()
    `;

        return await this.evaluateScript<LyricLine[]>(script);
    }

    async fetchSongDetail(playId: string): Promise<SongInfo | null> {
        const state = await this.evaluateScript<any>(`(function() {
          const p = window.yesplaymusic && window.yesplaymusic.player;
          const t = p && p._currentTrack;
          if (!t) return null;
          const artists = Array.isArray(t.ar) ? t.ar : (Array.isArray(t.artists) ? t.artists : []);
          return {
            id: t.id != null ? String(t.id) : '',
            title: String(t.name || t.title || ''),
            artist: artists.map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean).join(' / '),
            duration: Number(t.dt != null ? t.dt : t.duration) || 0
          };
        })()`);

        const title = String(state?.title || '').trim();
        if (!title) return null;

        const trackId = String(state?.id || playId || '');
        const rawDuration = Number(state?.duration) || 0;
        // YesPlayMusic track.dt 是毫秒；统一转换为秒供 YPMVRChatSyncV2 使用。
        const duration = rawDuration > 10000 ? rawDuration / 1000 : rawDuration;
        let lyrics: LyricLine[] = [];
        if (/^\d+$/.test(trackId)) {
            try {
                lyrics = await this.fetchLyrics(trackId);
                console.log(`[Lyrics] YesPlayMusic track ${trackId}: ${lyrics.length} lines`);
            } catch (error) {
                console.error('[Lyrics] Failed to load lyrics:', error);
            }
        } else {
            console.warn('[Lyrics] Current track has no numeric song ID; cannot request NetEase lyrics API.');
        }

        const info: SongInfo = {
            title,
            artist: String(state?.artist || ''),
            duration,
            lyrics
        };
        this.songCache.set(playId, info);
        if (trackId && trackId !== playId) this.songCache.set(trackId, info);
        return info;
    }

    async fetchSongInfoFromRedux(): Promise<{
        playId: string;
        title: string;
        artist: string;
        duration: number;
    } | null> {
        const script = `
      (function() {
        const store = window.__REDUX_STORE__;
        if (!store) return null;

        const state = store.getState();
        const playing = state.playing;
        if (!playing || !playing.playId) return null;

        return {
          playId: String(playing.playId),
          title: playing.resourceName || '',
          artist: (playing.resourceArtists || []).map(a => a.name || a).join(' / '),
          duration: playing.resourceDuration || 0
        };
      })()
    `;

        return await this.evaluateScript(script);
    }

    async getPlayStatus(): Promise<PlayStatus> {
        const value = await this.evaluateScript<any>(`(function() {
          const p = window.yesplaymusic && window.yesplaymusic.player;
          const t = p && p._currentTrack;
          if (!p || !t) return null;
          const artists = Array.isArray(t.ar) ? t.ar : (Array.isArray(t.artists) ? t.artists : []);
          const artist = artists.map(a => typeof a === 'string' ? a : (a && a.name) || '').filter(Boolean).join(' / ');
          const title = String(t.name || t.title || '');
          const id = t.id != null ? String(t.id) : (title + '|' + artist);
          const progress = Number(p._progress);
          return {
            playId: id || null,
            current: Number.isFinite(progress) ? progress : 0,
            cacheProgress: null,
            lastUpdate: Date.now(),
            state: p._playing ? 1 : 2,
            isPlaying: !!p._playing
          };
        })()`);
        if (!value) {
            return { playId: null, current: null, cacheProgress: null, lastUpdate: null, state: null, isPlaying: false };
        }
        const cachedInfo = value.playId ? this.songCache.get(value.playId) : undefined;
        if (cachedInfo) value.songInfo = cachedInfo;
        return value as PlayStatus;
    }

    async startMonitoring(intervalMs = 500): Promise<void> {
        // 等待页面完全加载
        let isPageReady = false;
        for (let i = 0; i < 30; i++) {
            const ready = await this.evaluateScript<boolean>(
                `(function() {
                    const pageReady = document.readyState === 'complete';
                    return pageReady && !!document.title;
                })()`
            );

            if (ready) {
                isPageReady = true;
                console.log("[Launch] Page fully loaded", ready);
                break;
            }

            await new Promise((r) => setTimeout(r, 500));
        }

        if (!isPageReady) {
            console.warn("[Launch] Page may not be fully loaded, proceeding anyway");
        }

        console.log(await this.evaluateScript(INJECT_SCRIPT, true));
        console.log("[Monitor] Native callbacks subscribed\n");

        let lastPlayId: string | null = null;
        let lastLyric: string = "";
        let currentSongInfo: SongInfo | null = null;

        const logSongInfo = (time: string, info: SongInfo, current: number) => {
            const cur = current.toFixed(2);
            const dur = info.duration.toFixed(2);
            const pct = ((current / info.duration) * 100).toFixed(1);
            console.log(`[${time}] 🎵 ${info.title} - ${info.artist} | ${cur}s / ${dur}s (${pct}%)`);
        };

        const logLyric = (time: string, lyric: LyricLine) => {
            console.log(`[${time}] 🎤 ${lyric.text}`);
            if (ENABLE_LYRICS_TRANSLATION && lyric.translatedText) {
                console.log(`[${time}] 🌐 ${lyric.translatedText}`);
            }
        };

        const poll = async () => {
            if (this.abortController.signal.aborted) return;

            try {
                const s = await this.getPlayStatus();
                if (!s.playId || s.current === null) return;

                const time = new Date().toLocaleTimeString();
                if (s.playId !== lastPlayId) {
                    lastPlayId = s.playId;
                    lastLyric = "";
                    console.log(`[${time}] Detected YesPlayMusic track: ${s.playId}`);
                    const info = await this.fetchSongDetail(s.playId);
                    if (info) {
                        currentSongInfo = info;
                        s.songInfo = info;
                        logSongInfo(time, info, s.current);
                    } else {
                        currentSongInfo = null;
                    }
                } else {
                    const info = this.songCache.get(s.playId) || currentSongInfo || s.songInfo;
                    if (info) {
                        currentSongInfo = info;
                        s.songInfo = info;
                        const lyric = getCurrentLyric(info.lyrics, s.current);
                        if (lyric && lyric.text !== lastLyric) {
                            logSongInfo(time, info, s.current);
                            logLyric(time, lyric);
                            lastLyric = lyric.text;
                        }
                    }
                }

                this.win.webContents.send("ncm-play-state", s);
            } catch (error) {
                if ((error as Error).message === "Not connected") {
                    console.log("[Monitor] Connection lost, attempting to reconnect...");
                    if (!this.isManualDisconnect && !this.abortController.signal.aborted) {
                        this.tryReconnect();
                    }
                    return;
                }
                console.error("[Monitor] Poll error:", error);
            }
        };

        await poll();

        const pollLoop = async () => {
            while (!this.abortController.signal.aborted) {
                await new Promise<void>((resolve) => {
                    setTimeout(() => {
                        if (!this.abortController.signal.aborted) {
                            resolve();
                        }
                    }, intervalMs);
                });

                if (!this.abortController.signal.aborted) {
                    await poll();
                }
            }
        };

        pollLoop().catch((error) => {
            if (error.name !== "AbortError") {
                console.error("[Monitor] Poll loop error:", error);
            }
        });
    }

    disconnect(): void {
        this.isManualDisconnect = true;

        this.abortController.abort();

        if (this.ws) {
            try {
                this.ws.close();
                this.ws = null;
                console.log("[Monitor] Disconnected");
            } catch (error) {
                console.error("[Monitor] Error closing WebSocket:", error);
            }
        }
        this.pending.clear();
        this.sessionId = null;
    }
}
