import { BrowserWindow, dialog } from "electron";
import { configManager } from "./config";

export async function selectDirectory(win: BrowserWindow) {
    const result = await dialog.showOpenDialog(win, {
        title: "选择YesPlayMusic",
        properties: ["openFile"],
        filters: [{ name: "应用程序", extensions: ["app", "exe", "lnk"] }]
    });

    if (result.canceled) {
        return null;
    }

    const selectedPath = result.filePaths[0];

    if (selectedPath) {
        try {
            await configManager.save({ ncmPath: selectedPath });
            console.log("[Dialog] Saved YPM path to config:", selectedPath);
        } catch (error) {
            console.error("[Dialog] Failed to save YPM path:", error);
        }
    }

    return selectedPath;
}
