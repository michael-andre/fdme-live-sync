import { Observable, Subscription, mergeMap } from "rxjs";
import { LiveUpdate } from "./data";

export class LocalBroadcastConsumer {

  constructor(private readonly wsHost: string) {}

  private readonly ws = new WebSocket(`ws://${this.wsHost}:7000`);
  private readonly openedWs = new Promise<WebSocket>((resolve) => {
    this.ws.onopen = () => resolve(this.ws);
  });

  subscribe(updates: Observable<Partial<LiveUpdate>>): Subscription {
    return updates.pipe(
      mergeMap(async (update) => {
      (await this.openedWs).send(JSON.stringify(update));
    })).subscribe();
  }

}