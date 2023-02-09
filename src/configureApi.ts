import Urbit from "./index";

declare global {
  var api: Urbit;
  var desk: string;
}

export const deSig = (patp: string) => patp.replace(/^~/, '');

export const configureApi = (ship: string, shipUrl: string) => {
  const api = new Urbit(shipUrl, '', 'landscape', deSig(ship)!);
  window.desk = 'landscape';

  api.onError = (e: any) => {
    (async () => {
      // const { reconnect, errorCount, set } = useLocalState(deSig(ship) || '').getState();
      // if(errorCount > 1) {
      //   set((s: any) => {
      //     s.subscription = 'disconnected';
      //   });
      //   return;
      // }
      // try {
      //   await reconnect();
      // } catch (e) {
      // }
    })();
  };

  api.onRetry = () => {
    // useLocalState(ship).setState({ subscription: 'reconnecting' });
  };

  api.onOpen = () => {
    // useLocalState(ship).setState({ subscription: 'connected' });
  };

  return api;
}
