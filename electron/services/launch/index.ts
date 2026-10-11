import { ChildProcess, spawn } from "child_process";
import { BrowserWindow } from "electron";
import net from "net";
import { configManager } from "../config";
import { OSCService } from "../osc";
import { NeteasePlayMonitor } from "./monitor";

let childProcess: ChildProcess | null = null;
let monitor: NeteasePlayMonitor | null = null;
let oscMonitorInterval: NodeJS.Timeout | null = null;
let oscService: OSCService | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAppPath: string | null = null;

const DEBUG_PORT = 9222;

let launchTask: Promise<void> | null = null;
let closeTask: Promise<void> | null = null;
let operationGeneration = 0;
let isClosingSync = false;

// 检查本机端口是否可以连接。
function checkPort(
port: number,
timeout = 300
): Promise<boolean> {
return new Promise((resolve) => {
const socket = new net.Socket();
let settled = false;

const finish = (result: boolean) => {
if (settled) return;

settled = true;
socket.destroy();
resolve(result);
};

socket.setTimeout(timeout);
socket.once("connect", () => finish(true));
socket.once("error", () => finish(false));
socket.once("timeout", () => finish(false));

socket.connect(port, "127.0.0.1");
});
}

function delay(ms: number): Promise<void> {
return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等待指定端口开放。
async function waitForPort(
port: number,
timeoutMs = 20000
): Promise<boolean> {
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
if (await checkPort(port, 300)) {
return true;
}

await delay(250);
}

return false;
}

function sendStatus(
win: BrowserWindow,
status: boolean
): void {
if (!win.isDestroyed()) {
win.webContents.send("ncm-status", status);
}
}

function isCurrentOperation(generation: number): boolean {
return (
!isClosingSync &&
generation === operationGeneration
);
}

// 取出当前监控器并清空全局引用。
function takeMonitor(): NeteasePlayMonitor | null {
const current = monitor;
monitor = null;
return current;
}

// 连接 YesPlayMusic 的远程调试接口并启动监控。
async function startNeteasePlayMonitoring(
win: BrowserWindow,
port: number
): Promise<boolean> {
const previousMonitor = takeMonitor();
previousMonitor?.disconnect();

const newMonitor = new NeteasePlayMonitor(win, port);
monitor = newMonitor;

try {
await newMonitor.connect();
await newMonitor.attachToOrpheusPage();
await newMonitor.startMonitoring(500);

console.log("[Launch] YPM monitoring started");
return true;
} catch (error) {
console.error(
"[Launch] Error starting YPM monitoring:",
error
);

newMonitor.disconnect();

if (monitor === newMonitor) {
monitor = null;
}

return false;
}
}

// 启动 OSC 同步。
export async function startOSCMonitoring(
win: BrowserWindow
): Promise<boolean> {
const currentMonitor = monitor;

if (!currentMonitor) {
console.error("[OSC] Monitor not initialized");
return false;
}

stopOSCMonitoring();

try {
const settings = configManager.get();
const service = new OSCService(
settings.osc.ip,
settings.osc.port
);

oscService = service;

console.log("[OSC] Service initialized");

let updating = false;

oscMonitorInterval = setInterval(async () => {
// 防止上一次异步更新尚未结束时再次执行。
if (updating) return;
updating = true;

try {
const playStatus = await currentMonitor.getPlayStatus();

if (!playStatus.songInfo && playStatus.playId) {
const songInfo =
await currentMonitor.fetchSongDetail(
playStatus.playId
);

if (songInfo) {
playStatus.songInfo = songInfo;
}
}

const lyrics = playStatus.songInfo?.lyrics || [];

const result = await service.updatePlayStatus(
playStatus,
lyrics
);

if (result && !win.isDestroyed()) {
win.webContents.send("osc-output", result);
}
} catch (error) {
console.error("[OSC] Monitoring error:", error);
} finally {
updating = false;
}
}, 300);

return true;
} catch (error) {
console.error(
"[OSC] Failed to start monitoring:",
error
);

oscService?.destroy();
oscService = null;

return false;
}
}

// 停止 OSC 同步，但不关闭 YesPlayMusic。
export function stopOSCMonitoring(): void {
if (oscMonitorInterval) {
clearInterval(oscMonitorInterval);
oscMonitorInterval = null;

console.log("[OSC] Monitoring stopped");
}

oscService?.destroy();
oscService = null;
}

/**
* 优先连接已经开放 9222 端口的 YesPlayMusic。
* 如果端口没有开放，则使用前端提供的 exe 路径启动。
* 不会为了连接失败而强制结束 YesPlayMusic。
*/
async function launchInternal(
appPath: string,
win: BrowserWindow,
generation: number
): Promise<void> {
mainWindow = win;

if (!appPath) {
console.error(
"[Launch] 未收到 YesPlayMusic 可执行文件路径"
);

sendStatus(win, false);
return;
}

currentAppPath = appPath;

try {
let portReady = await checkPort(DEBUG_PORT, 500);

if (!isCurrentOperation(generation)) {
return;
}

if (portReady) {
console.log(
`[Launch] 发现已有调试端口 ${DEBUG_PORT}，尝试连接现有 YPM`
);
} else {
console.log(
"[Launch] 未发现调试端口，尝试启动：",
currentAppPath
);

const proc = spawn(
currentAppPath,
[`--remote-debugging-port=${DEBUG_PORT}`],
{
stdio: "ignore",
windowsHide: true
}
);

childProcess = proc;

proc.once("error", (error) => {
console.error(
"[Launch] 启动 YesPlayMusic 失败：",
error
);
});

proc.once("exit", (code, signal) => {
console.log(
`[Launch] YPM 启动进程退出，code=${code}, signal=${signal}`
);

if (childProcess === proc) {
childProcess = null;
}
});

portReady = await waitForPort(DEBUG_PORT, 20000);

if (!isCurrentOperation(generation)) {
return;
}
}

if (!portReady) {
console.error(
"[Launch] 9222 端口不可用。请确认 YPM 已启动且开放了远程调试端口。"
);

sendStatus(win, false);
return;
}

const monitoringStarted =
await startNeteasePlayMonitoring(
win,
DEBUG_PORT
);

if (!isCurrentOperation(generation)) {
const currentMonitor = takeMonitor();
currentMonitor?.disconnect();
return;
}

sendStatus(win, monitoringStarted);
} catch (error) {
console.error("[Launch] 启动或连接失败：", error);
sendStatus(win, false);
}
}

/**
* 启动同步。
* 同一时间只允许一个启动任务。
* 如果正在关闭同步，则等待清理结束后再启动。
*/
export function launchWithArgs(
appPath: string,
win: BrowserWindow
): Promise<void> {
if (closeTask) {
return closeTask.then(() => launchWithArgs(appPath, win));
}

if (launchTask) {
return launchTask;
}

isClosingSync = false;
mainWindow = win;
currentAppPath = appPath;

const generation = operationGeneration;
const task = launchInternal(
appPath,
win,
generation
);

launchTask = task;

void task.then(
() => {
if (launchTask === task) {
launchTask = null;
}
},
(error) => {
console.error("[Launch] 启动任务异常：", error);

if (launchTask === task) {
launchTask = null;
}
}
);

return task;
}

// 提供给 IPC 层获取当前监控器。
export function getMonitor(): NeteasePlayMonitor | null {
return monitor;
}

/**
* 仅关闭同步功能，不退出 YesPlayMusic。
* 等待启动流程及监控器清理完成后，才允许再次启动。
*/
export function closeChildProcess(): Promise<void> {
if (closeTask) {
return closeTask;
}

isClosingSync = true;
++operationGeneration;

stopOSCMonitoring();

const oldMonitor = takeMonitor();
oldMonitor?.disconnect();

if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.send("ncm-status", false);
}

const pendingLaunch = launchTask;

const task = (async (): Promise<void> => {
// 等待正在进行的启动流程结束。
if (pendingLaunch) {
try {
await pendingLaunch;
} catch (error) {
console.error(
"[Launch] 等待启动任务结束时出错：",
error
);
}
}

// 再次清理，避免启动流程创建新的监控器。
stopOSCMonitoring();

const remainingMonitor = takeMonitor();
remainingMonitor?.disconnect();

// 不调用 taskkill，不结束 YesPlayMusic。
childProcess = null;

console.log(
"[Launch] 同步已关闭，YesPlayMusic 保持运行"
);
})();

closeTask = task;

void task.then(
() => {
if (closeTask === task) {
closeTask = null;
}
},
(error) => {
console.error("[Launch] 关闭同步时发生错误：", error);

if (closeTask === task) {
closeTask = null;
}
}
);

return task;
}
