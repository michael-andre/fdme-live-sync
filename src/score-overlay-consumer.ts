import * as http from "http";
import * as path from "path";
import { Observable, ReplaySubject, Subscription, throttleTime } from "rxjs";
import { Server } from "ws";
import { MatchUpdate } from "./main";
import { readFile } from "fs/promises";

export class ScoreOverlayConsumer {

  constructor(private readonly port: number) { }

  subscribe(updates: Observable<MatchUpdate>): Subscription {

    // Setup HTTP server
    const httpServer = http.createServer(async (req, res) => {
      if (req.url == "/") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.write(await readFile(path.join(__dirname, "..", "assets", "score-overlay.html")));
      } else {
        res.statusCode = 404;
      }
      res.end();
    });

    // Add WS client with replay
    const subject = new ReplaySubject<MatchUpdate>(1);
    const sub = updates.pipe(
      throttleTime(200, undefined, { leading: true, trailing: true })
    ).subscribe({
        next: update => subject.next(update)
      });
    const wsServer = new Server({ server: httpServer, path: "/updates" });
    wsServer.on("listening", () => {
      console.info(`Score overlay server listening on ${JSON.stringify(httpServer.address())}`);
    });
    wsServer.on("connection", ws => {
      console.info("Score overlay WS client connected");
      const sub = subject.subscribe({
        next: update => ws.send(JSON.stringify(update))
      });
      ws.on("close", () => sub.unsubscribe());
      ws.on("error", e => {
        console.error("Score overlay WS connection error");
        console.error(e);
      });
    });

    // Handle closing
    sub.add(() => {
      wsServer.close();
      httpServer.closeAllConnections();
      httpServer.close();
    });

    httpServer.on("error", e => {
      console.error("Score overlay WS server error");
      console.error(e);
    });
    httpServer.listen(this.port);
    return sub;
  }

}