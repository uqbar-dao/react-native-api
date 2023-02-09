import EventSource from "react-native-sse";

export class ResumableError extends Error {}
export class FatalError extends Error {}

interface PokeParams {
  app: string;
  mark: string;
  json: any;
  ship?: string;
  onSuccess?: (payload?: any) => void;
  onError?: (err?: any) => void;
}

interface SubscribeParams {
  app: string;
  path: string;
  ship?: string;
  err?: (payload?: any) => void;
  event?: (payload?: any) => void;
  quit?: (payload?: any) => void;
}

declare global {
  var api: Urbit;
  var desk: string;
}

/**
 * Returns a hex string of given length.
 *
 * Poached from StackOverflow.
 *
 * @param len Length of hex string to return.
 */
function hexString(len: number) {
    const maxlen = 8;
    const min = Math.pow(16, Math.min(len, maxlen) - 1);
    const max = Math.pow(16, Math.min(len, maxlen)) - 1;
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    let r = n.toString(16);
    while (r.length < len) {
        r = r + hexString(len - maxlen);
    }
    return r;
}

/**
 * A class for interacting with an urbit ship, given its URL and code
 */
class Urbit {
  url: string;
  code?: string;
  desk: string;
  ship: string;
  verbose: boolean;
  uid: string;
  lastEventId: number;
  lastAcknowledgedEventId: number;
  sseClientInitialized: boolean;
  outstandingPokes: Map<string, any>;
  outstandingSubscriptions: Map<string, any>;
  abort: any;
  errorCount: any;
  onError: any;
  onRetry: any;
  onOpen: any;
  delete: () => void;
    /**
     * Constructs a new Urbit connection.
     *
     * @param url  The URL (with protocol and port) of the ship to be accessed. If
     * the airlock is running in a webpage served by the ship, this should just
     * be the empty string.
     * @param code The access code for the ship at that address
     */
    constructor(url: string, code: string, desk: string, ship: string) {
        this.url = url;
        this.code = code;
        this.desk = desk;
        this.ship = ship
        this.verbose = true
        /**
         * UID will be used for the channel: The current unix time plus a random hex string
         */
        this.uid = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;
        /**
         * Last Event ID is an auto-updated index of which events have been sent over this channel
         */
        this.lastEventId = 0;
        this.lastAcknowledgedEventId = 0;
        /**
         * SSE Client is null for now; we don't want to start polling until it the channel exists
         */
        this.sseClientInitialized = false;
        /**
         * A registry of requestId to successFunc/failureFunc
         *
         * These functions are registered during a +poke and are executed
         * in the onServerEvent()/onServerError() callbacks. Only one of
         * the functions will be called, and the outstanding poke will be
         * removed after calling the success or failure function.
         */
        this.outstandingPokes = new Map();
        /**
         * A registry of requestId to subscription functions.
         *
         * These functions are registered during a +subscribe and are
         * executed in the onServerEvent()/onServerError() callbacks. The
         * event function will be called whenever a new piece of data on this
         * subscription is available, which may be 0, 1, or many times. The
         * disconnect function may be called exactly once.
         */
        this.outstandingSubscriptions = new Map();
        /**
         * Our abort controller, used to close the connection
         */
        this.abort = new AbortController();
        /**
         * number of consecutive errors in connecting to the eventsource
         */
        this.errorCount = 0;
        this.onError = null;
        this.onRetry = null;
        this.onOpen = null;
        this.delete = () => this.outstandingPokes.clear()
        return this;
    }
    /** This is basic interpolation to get the channel URL of an instantiated Urbit connection. */
    get channelUrl() {
        return `${this.url}/~/channel/${this.uid}`;
    }
    get fetchOptions(): RequestInit {
        const headers = {
            'Content-Type': 'application/json',
        };
        return {
            credentials: 'include',
            headers,
            signal: this.abort.signal,
        };
    }
    /**
     * Initializes the SSE pipe for the appropriate channel.
     */
    async eventSource() {
        if (this.sseClientInitialized) {
            return Promise.resolve(true);
        }
        if (this.lastEventId === 0) {
            // Can't receive events until the channel is open,
            // so poke and open then
            await this.poke({
                app: 'hood',
                mark: 'helm-hi',
                json: 'Opening API channel',
            });
            return;
        }
        this.sseClientInitialized = true;
        return new Promise((resolve, reject) => {
            const es = new EventSource(this.channelUrl);

            es.addEventListener("open", (event) => {
              console.log("Open SSE connection.");
              this.errorCount = 0;
              this.onOpen && this.onOpen();
              resolve(true);
              return; // everything's good
            });

            es.addEventListener("message", (event: any) => {
              const eventId: string = (event && event.data && JSON.parse(event.data)?.id) || ''
              // console.log("New message event:", eventId);
              if (!eventId)
                return;
              this.lastEventId = parseInt(eventId, 10);
              if (this.lastEventId - this.lastAcknowledgedEventId > 20) {
                  this.ack(this.lastEventId);
              }
              if (event.data && JSON.parse(event.data)) {
                const data = JSON.parse(event.data);
                const subId = String(data.id);

                if (data.response === 'poke' &&
                    this.outstandingPokes.has(subId)) {
                    const funcs = this.outstandingPokes.get(subId);
                    if (data.hasOwnProperty('ok')) {
                      funcs.onSuccess();
                    }
                    else if (data.hasOwnProperty('err')) {
                      console.error(data.err);
                      funcs.onError(data.err);
                    }
                    else {
                      console.error('Invalid poke response', data);
                    }
                    this.outstandingPokes.delete(subId);
                }
                else if (data.response === 'subscribe' &&
                    this.outstandingSubscriptions.has(subId)) {
                    const funcs = this.outstandingSubscriptions.get(subId);
                    if (data.hasOwnProperty('err')) {
                      console.error(data.err);
                      funcs.err(data.err, subId);
                      this.outstandingSubscriptions.delete(subId);
                    }
                }
                else if (data.response === 'diff' &&
                  this.outstandingSubscriptions.has(subId)) {
                  const funcs = this.outstandingSubscriptions.get(subId);
                  try {
                    funcs.event(data.json);
                  }
                  catch (e) {
                    console.error('Failed to call subscription event callback', e);
                  }
                }
                else if (data.response === 'quit' &&
                  this.outstandingSubscriptions.has(subId)) {
                  const funcs = this.outstandingSubscriptions.get(subId);
                  funcs.quit(data);
                  this.outstandingSubscriptions.delete(subId);
                }
                else {
                  // console.log([...this.outstandingSubscriptions.keys()]);
                  // console.log('Unrecognized response', data);
                }
              }
            });

            es.addEventListener("error", (event) => {
              console.warn(event);
              if (this.errorCount++ < 4) {
                  this.onRetry && this.onRetry();
                  return Math.pow(2, this.errorCount - 1) * 750;
              }
              this.onError && this.onError(event);
              throw event;
            });

            es.addEventListener("close", (event) => {
              console.log(event);
              throw new Error('Ship unexpectedly closed the connection');
            });


            // fetchEventSource(this.channelUrl, {
            //     ...this.fetchOptions,
            //     openWhenHidden: true,
            //     onopen: async (response) => {
            //         if (this.verbose) {
            //             console.log('Opened eventsource', response);
            //         }
            //         if (response.ok) {
            //             this.errorCount = 0;
            //             this.onOpen && this.onOpen();
            //             resolve(true);
            //             return; // everything's good
            //         }
            //         else {
            //             const err = new Error('failed to open eventsource');
            //             reject(err);
            //         }
            //     },
            //     onmessage: (event) => {
            //         if (this.verbose) {
            //             console.log('Received SSE: ', event);
            //         }
            //         if (!event.id)
            //             return;
            //         this.lastEventId = parseInt(event.id, 10);
            //         if (this.lastEventId - this.lastAcknowledgedEventId > 20) {
            //             this.ack(this.lastEventId);
            //         }
            //         if (event.data && JSON.parse(event.data)) {
            //             const data = JSON.parse(event.data);
            //             if (data.response === 'poke' &&
            //                 this.outstandingPokes.has(data.id)) {
            //                 const funcs = this.outstandingPokes.get(data.id);
            //                 if (data.hasOwnProperty('ok')) {
            //                     funcs.onSuccess();
            //                 }
            //                 else if (data.hasOwnProperty('err')) {
            //                     console.error(data.err);
            //                     funcs.onError(data.err);
            //                 }
            //                 else {
            //                     console.error('Invalid poke response', data);
            //                 }
            //                 this.outstandingPokes.delete(data.id);
            //             }
            //             else if (data.response === 'subscribe' &&
            //                 this.outstandingSubscriptions.has(data.id)) {
            //                 const funcs = this.outstandingSubscriptions.get(data.id);
            //                 if (data.hasOwnProperty('err')) {
            //                     console.error(data.err);
            //                     funcs.err(data.err, data.id);
            //                     this.outstandingSubscriptions.delete(data.id);
            //                 }
            //             }
            //             else if (data.response === 'diff' &&
            //                 this.outstandingSubscriptions.has(data.id)) {
            //                 const funcs = this.outstandingSubscriptions.get(data.id);
            //                 try {
            //                     funcs.event(data.json);
            //                 }
            //                 catch (e) {
            //                     console.error('Failed to call subscription event callback', e);
            //                 }
            //             }
            //             else if (data.response === 'quit' &&
            //                 this.outstandingSubscriptions.has(data.id)) {
            //                 const funcs = this.outstandingSubscriptions.get(data.id);
            //                 funcs.quit(data);
            //                 this.outstandingSubscriptions.delete(data.id);
            //             }
            //             else {
            //                 console.log([...this.outstandingSubscriptions.keys()]);
            //                 console.log('Unrecognized response', data);
            //             }
            //         }
            //     },
            //     onerror: (error) => {
            //         console.warn(error);
            //         if (this.errorCount++ < 4) {
            //             this.onRetry && this.onRetry();
            //             return Math.pow(2, this.errorCount - 1) * 750;
            //         }
            //         this.onError && this.onError(error);
            //         throw error;
            //     },
            //     onclose: () => {
            //         console.log('e');
            //         throw new Error('Ship unexpectedly closed the connection');
            //     },
            // });
        });
    }
    /**
     * Reset airlock, abandoning current subscriptions and wiping state
     *
     */
    reset() {
        this.delete();
        this.abort.abort();
        this.abort = new AbortController();
        this.uid = `${Math.floor(Date.now() / 1000)}-${hexString(6)}`;
        this.lastEventId = 0;
        this.lastAcknowledgedEventId = 0;
        this.outstandingSubscriptions = new Map();
        this.outstandingPokes = new Map();
        this.sseClientInitialized = false;
    }
    /**
     * Autoincrements the next event ID for the appropriate channel.
     */
    getEventId() {
        this.lastEventId = Number(this.lastEventId) + 1;
        return this.lastEventId;
    }
    /**
     * Acknowledges an event.
     *
     * @param eventId The event to acknowledge.
     */
    async ack(eventId: number) {
        this.lastAcknowledgedEventId = eventId;
        const message = {
            action: 'ack',
            'event-id': eventId,
        };
        await this.sendJSONtoChannel(message);
        return eventId;
    }
    async sendJSONtoChannel(...json: any) {
        const response = await fetch(this.channelUrl, {
            ...this.fetchOptions,
            method: 'PUT',
            body: JSON.stringify(json),
        });
        if (!response.ok) {
            throw new Error('Failed to PUT channel');
        }
        if (!this.sseClientInitialized) {
            await this.eventSource();
        }
    }
    /**
     * Creates a subscription, waits for a fact and then unsubscribes
     *
     * @param app Name of gall agent to subscribe to
     * @param path Path to subscribe to
     * @param timeout Optional timeout before ending subscription
     *
     * @returns The first fact on the subcription
     */
    async subscribeOnce<T>(app: string, path: string, timeout: number): Promise<T> {
        return new Promise(async (resolve, reject) => {
            let done = false;
            let id: number | null = null;
            const quit = () => {
                if (!done) {
                    reject('quit');
                }
            };
            const event = (e: any) => {
                if (!done) {
                    resolve(e);
                    this.unsubscribe(id);
                }
            };
            const request = { app, path, event, err: reject, quit };
            id = await this.subscribe(request);
            if (timeout) {
                setTimeout(() => {
                    if (!done) {
                        done = true;
                        reject('timeout');
                        this.unsubscribe(id);
                    }
                }, timeout);
            }
        });
    }
    /**
     * Pokes a ship with data.
     *
     * @param app The app to poke
     * @param mark The mark of the data being sent
     * @param json The data to send
     */
    async poke(params: PokeParams) {
        const { app, mark, json, ship, onSuccess = () => null, onError = () => null } = {
            ship: this.ship,
            ...params,
        };
        const message = {
            id: this.getEventId(),
            action: 'poke',
            ship,
            app,
            mark,
            json,
        };
        const [send, result] = await Promise.all([
            this.sendJSONtoChannel(message),
            new Promise((resolve, reject) => {
                this.outstandingPokes.set(String(message.id), {
                    onSuccess: () => {
                        onSuccess();
                        resolve(message.id);
                    },
                    onError: (event: any) => {
                        onError(event);
                        reject(event);
                    },
                });
            }),
        ]);
        return result;
    }
    /**
     * Subscribes to a path on an app on a ship.
     *
     *
     * @param app The app to subsribe to
     * @param path The path to which to subscribe
     * @param handlers Handlers to deal with various events of the subscription
     */
    async subscribe(params: SubscribeParams) {
        const { app, path, ship, err = () => null, event = () => null, quit = () => null } = {
            ship: this.ship,
            ...params,
        };
        const message = {
            id: this.getEventId(),
            action: 'subscribe',
            ship,
            app,
            path,
        };
        this.outstandingSubscriptions.set(String(message.id), {
            app,
            path,
            err,
            event,
            quit,
        });
        await this.sendJSONtoChannel(message);
        return message.id;
    }
    /**
     * Unsubscribes to a given subscription.
     *
     * @param subscription
     */
    async unsubscribe(subscription: any) {
        return this.sendJSONtoChannel({
            id: this.getEventId(),
            action: 'unsubscribe',
            subscription,
        }).then(() => {
            this.outstandingSubscriptions.delete(subscription);
        });
    }
    /**
     * Scry into an gall agent at a path
     *
     * @typeParam T - Type of the scry result
     *
     * @remarks
     *
     * Equivalent to
     * ```hoon
     * .^(T %gx /(scot %p our)/[app]/(scot %da now)/[path]/json)
     * ```
     * The returned cage must have a conversion to JSON for the scry to succeed
     *
     * @param params The scry request
     * @returns The scry result
     */
    async scry<T>(params: { app: string; path: string }): Promise<T> {
        const { app, path } = params;
        const response = await fetch(`${this.url}/~/scry/${app}${path}.json`, this.fetchOptions);
        return await response.json();
    }
    /**
     * Run a thread
     *
     *
     * @param inputMark   The mark of the data being sent
     * @param outputMark  The mark of the data being returned
     * @param threadName  The thread to run
     * @param body        The data to send to the thread
     * @returns  The return value of the thread
     */
    async thread(params: any) {
        const { inputMark, outputMark, threadName, body, desk = this.desk } = params;
        if (!desk) {
            throw new Error('Must supply desk to run thread from');
        }
        const res = await fetch(`${this.url}/spider/${desk}/${inputMark}/${threadName}/${outputMark}.json`, {
            ...this.fetchOptions,
            method: 'POST',
            body: JSON.stringify(body),
        });
        return res.json();
    }
}

export default Urbit
