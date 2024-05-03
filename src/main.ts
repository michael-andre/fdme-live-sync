import { app } from "electron";
import log from "electron-log/main";
import { Subscription, filter } from "rxjs";
import { LiveSyncConsumer } from "./live-sync-consumer";
import { configureTrayIcon } from "./menu";
import { ScoreOverlayConsumer } from "./score-overlay-consumer";
import { ScoreSheetSource } from "./score-sheet-provider";
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

    const scoreSheetSource = new ScoreSheetSource(testMode);
    const scorepadSource = new ScorepadSource();

    // Configure tray icon
    trayCallback = configureTrayIcon(scoreSheetSource.state, scorepadSource.state);

    updatesSub = new Subscription();
    updatesSub.add(new LiveSyncConsumer().subscribe(scoreSheetSource.updates, scorepadSource.updates));
    updatesSub.add(new ScoreOverlayConsumer(4000).subscribe(scoreSheetSource.updates.pipe(filter((u): u is MatchUpdate => u != null))));
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