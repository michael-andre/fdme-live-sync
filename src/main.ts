import { app } from "electron";
import log from "electron-log/main";
import { Subscription } from "rxjs";
import { ScoreSheetSource } from "./score-sheet-provider";
import { LiveSyncConsumer } from "./live-sync-consumer";
import { LocalBroadcastConsumer } from "./local-broadcast";
import { configureTrayIcon } from "./menu";
import { ScorepadSource } from "./scorepad-provider";

export type SourceState = "off" | "ready" | "connected" | "error";

let trayCallback: (() => void) | undefined;
let updatesSub: Subscription | undefined;

log.initialize({ preload: true });
Object.assign(console, log.functions);

app.whenReady().then(() => {

  try {
    const testMode = app.commandLine.getSwitchValue("mode") == "test";
    if (testMode) console.debug("Running in test mode");

    const scoreSheetSoure = new ScoreSheetSource(testMode);
    const scorepadSource = new ScorepadSource();

    // Configure tray icon
    trayCallback = configureTrayIcon(scoreSheetSoure.state, scorepadSource.state);

    updatesSub = new Subscription();
    updatesSub.add(new LiveSyncConsumer().subscribe(scoreSheetSoure.updates, scorepadSource.updates));
    updatesSub.add(new LocalBroadcastConsumer("192.168.0.200").subscribe(scorepadSource.updates));
  } catch (error) {
    console.error("Initialization error");
    console.error(error);
  }

});

app.on("before-quit", function () {
  updatesSub?.unsubscribe();
  trayCallback?.();
});

app.on("window-all-closed", () => {
  app.dock?.hide();
});

export type MatchUpdate = Partial<{
  matchCode: string,
  homeScore: number,
  awayScore: number,
  chrono: number,
  period: number,
  chronoStarted: boolean
}>;