import { app, Tray, Menu, desktopCapturer, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { Observable, Subscription, defer, mergeMap, repeat } from "rxjs";
import { createWorker } from "tesseract.js";
import { CaptureData } from "./capture";
import Tesseract = require("tesseract.js");

let appTray: Tray | undefined;
let sourcesSubscription: Subscription | undefined;
let ocrSubscription: Subscription | undefined;

app.whenReady().then(() => {

  appTray = new Tray(path.join(__dirname, "../assets/icon.png"));
  const contextMenu = Menu.buildFromTemplate([
    { label: "Fermer", type: "normal", click: () => app.quit() }
  ]);
  appTray.setToolTip('This is my application.');
  appTray.setContextMenu(contextMenu);

  const windows = new Map<string, BrowserWindow>();

  sourcesSubscription = defer(async () => {
    const allSources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
    //console.debug("Available sources: " + JSON.stringify(allSources));
    //return [""];
    return allSources.filter(w => w.name == "Feuille de Table").map(w => w.id);
  }).pipe(
    repeat({ delay: 5000 }),
  ).subscribe({
    next: (sourceIds) => {
      try {
        // Create hidden capture window for new sources
        for (const sourceId of sourceIds) {
          if (windows.has(sourceId)) continue;
          console.debug(`Creating capturing window for '${sourceId}'`);
          const captureWindow = new BrowserWindow({
            show: false, webPreferences: {
              offscreen: true,
              preload: path.join(__dirname, 'capture.js'),
              nodeIntegration: true
            }
          });
          captureWindow.webContents.on('console-message', (_, level, message) => {
            console.log(message);
          });      
          captureWindow.loadFile("assets/capture-window.html", { hash: sourceId });
          // captureWindow.webContents.openDevTools({ mode: "detach" });
          windows.set(sourceId, captureWindow);
        }
        // Delete capture window for unavailable sources
        for (const [ sourceId, window ] of windows.entries()) {
          if (sourceIds.includes(sourceId)) continue;
          console.debug(`Closing capturing window for '${sourceId}'`);
          window.close();
          windows.delete(sourceId);
        }
      } catch (error) {
        console.error("Source windows error: " + error);
      }
    }
  });

  const ocrChronoScheduler = createWorker().then(async worker => {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    await worker.setParameters({
      tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY,
      tessedit_char_whitelist: '0123456789:',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD
    });
    const scheduler = Tesseract.createScheduler();
    scheduler.addWorker(worker);
    return scheduler;
  });
  const ocrScoreScheduler = createWorker().then(async worker => {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    await worker.setParameters({
      tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY,
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD
    });
    const scheduler = Tesseract.createScheduler();
    scheduler.addWorker(worker);
    return scheduler;
  });
  const ocrCodeScheduler = createWorker().then(async worker => {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    await worker.setParameters({
      tessedit_ocr_engine_mode: Tesseract.OEM.TESSERACT_ONLY,
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD
    });
    const scheduler = Tesseract.createScheduler();
    scheduler.addWorker(worker);
    return scheduler;
  });
  
  ocrSubscription = new Observable<CaptureData>((sub) => {
    const listener = (_: unknown, data: CaptureData) => {
      sub.next(data);
    };
    ipcMain.on("capture-data", listener);
    return () => ipcMain.off("capture-data", listener);
  }).pipe(
    mergeMap(async (dataUrl: CaptureData) => {
      try {
        const [ chrono, homeScore, awayScore, matchCode ] = await Promise.all([
          dataUrl.chrono ? (await ocrChronoScheduler).addJob("recognize", dataUrl.chrono).then(r => {
            const p = r.data.text.trim().match(/^(\d+):(\d+)$/);
            return p ? Number(p[1]) * 60 + Number(p[2]) : null;
          }) : Promise.resolve(null),
          dataUrl.homeScore ? (await ocrScoreScheduler).addJob("recognize", dataUrl.homeScore).then(r => {
            const p = r.data.text.trim().match(/^(\d+)$/);
            return p ? Number(p[1]) : null;
          }) : Promise.resolve(null),
          dataUrl.awayScore ? (await ocrScoreScheduler).addJob("recognize", dataUrl.awayScore).then(r => {
            const p = r.data.text.trim().match(/^(\d+)$/);
            return p ? Number(p[1]) : null;
          }) : Promise.resolve(null),
          dataUrl.matchCode ? (await ocrCodeScheduler).addJob("recognize", dataUrl.matchCode).then(r => {
            const p = r.data.text.trim().match(/^([A-Z]{7})$/);
            return p ? p[1] : null
          }) : Promise.resolve(null)
        ]);
        return { chrono, homeScore, awayScore, matchCode };
      } catch (error) {
        console.warn("OCR error: " + error);
        return {};
      }
    })
  ).subscribe({
    next: (result) => {
      console.log(JSON.stringify(result));
    }
  });
  
});

app.on('before-quit', function () {
  sourcesSubscription?.unsubscribe();
  ocrSubscription?.unsubscribe();
  appTray?.destroy();
});

app.on('window-all-closed', () => {
  app.dock?.hide();
})
