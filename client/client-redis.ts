import { Logger } from '@nestjs/common/services/logger.service';
import { loadPackage } from '@nestjs/common/utils/load-package.util';
import { fromEvent, merge, Subject, zip } from 'rxjs';
import { share, take, tap } from 'rxjs/operators';
import {
  CONNECT_EVENT,
  ERROR_EVENT,
  MESSAGE_EVENT,
  REDIS_DEFAULT_URL,
} from '../constants';
import {
  ClientOpts,
  RedisClient,
  RetryStrategyOptions,
} from '../external/redis.interface';
import { ReadPacket, RedisOptions, WritePacket } from '../interfaces';
import { ClientProxy } from './client-proxy';
import { ECONNREFUSED } from './constants';

let redisPackage: any = {};

export class ClientRedis extends ClientProxy {
  protected readonly logger = new Logger(ClientProxy.name);
  protected readonly subscriptionsCount = new Map<string, number>();
  protected readonly url: string;
  protected pubClient: RedisClient;
  protected subClient: RedisClient;
  protected connection: Promise<any>;
  protected isExplicitlyTerminated = false;

  constructor(protected readonly options: RedisOptions['options']) {
    super();
    this.url =
      this.getOptionsProp(options, 'url') ||
      (!this.getOptionsProp(options, 'host') && REDIS_DEFAULT_URL);

    redisPackage = loadPackage('redis', ClientRedis.name, () =>
      require('redis'),
    );

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public getRequestPattern(pattern: string): string {
    return pattern;
  }

  public getReplyPattern(pattern: string): string {
    return `${pattern}.reply`;
  }

  public close() {
    this.pubClient && this.pubClient.quit();
    this.subClient && this.subClient.quit();
    this.pubClient = this.subClient = null;
    this.isExplicitlyTerminated = true;
  }

  public connect(): Promise<any> {
    if (this.pubClient && this.subClient) {
      return this.connection;
    }
    const error$ = new Subject<Error>();

    this.pubClient = this.createClient(error$);
    this.subClient = this.createClient(error$);
    this.handleError(this.pubClient);
    this.handleError(this.subClient);

    const pubConnect$ = fromEvent(this.pubClient, CONNECT_EVENT);
    const subClient$ = fromEvent(this.subClient, CONNECT_EVENT);

    this.connection = merge(error$, zip(pubConnect$, subClient$))
      .pipe(
        take(1),
        tap(() =>
          this.subClient.on(MESSAGE_EVENT, this.createResponseCallback()),
        ),
        share(),
      )
      .toPromise();
    return this.connection;
  }

  public createClient(error$: Subject<Error>): RedisClient {
    return redisPackage.createClient({
      ...this.getClientOptions(error$),
      url: this.url,
    });
  }

  public handleError(client: RedisClient) {
    client.addListener(ERROR_EVENT, (err: any) => this.logger.error(err));
  }

  public getClientOptions(error$: Subject<Error>): Partial<ClientOpts> {
    const retry_strategy = (options: RetryStrategyOptions) =>
      this.createRetryStrategy(options, error$);

    return {
      ...(this.options || {}),
      retry_strategy,
    };
  }

  public createRetryStrategy(
    options: RetryStrategyOptions,
    error$: Subject<Error>,
  ): undefined | number | Error {
    if (options.error && (options.error as any).code === ECONNREFUSED) {
      error$.error(options.error);
    }
    if (this.isExplicitlyTerminated) {
      return undefined;
    }
    if (
      !this.getOptionsProp(this.options, 'retryAttempts') ||
      options.attempt > this.getOptionsProp(this.options, 'retryAttempts')
    ) {
      return new Error('Retry time exhausted');
    }
    return this.getOptionsProp(this.options, 'retryDelay') || 0;
  }

  public createResponseCallback(): (channel: string, buffer: string) => void {
    return (channel: string, buffer: string) => {
      const packet = JSON.parse(buffer);
      const { err, response, isDisposed, id } = this.deserializer.deserialize(
        packet,
      );

      const callback = this.routingMap.get(id);
      if (!callback) {
        return;
      }
      if (isDisposed || err) {
        return callback({
          err,
          response,
          isDisposed: true,
        });
      }
      callback({
        err,
        response,
      });
    };
  }

  protected publish(
    partialPacket: ReadPacket,
    callback: (packet: WritePacket) => any,
  ): Function {
    try {
      const packet = this.assignPacketId(partialPacket);
      const pattern = this.normalizePattern(partialPacket.pattern);
      const serializedPacket = this.serializer.serialize(packet);
      const responseChannel = this.getReplyPattern(pattern);
      let subscriptionsCount =
        this.subscriptionsCount.get(responseChannel) || 0;

      this.logger.error('subscriptionsCount ' + responseChannel + ':' + subscriptionsCount);
      console.log(`subscriptionsCount ${responseChannel}: ${subscriptionsCount}`)

      const publishPacket = () => {
        subscriptionsCount = this.subscriptionsCount.get(responseChannel) || 0;
        this.subscriptionsCount.set(responseChannel, subscriptionsCount + 1);
        this.routingMap.set(packet.id, callback);
        this.pubClient.publish(
          this.getRequestPattern(pattern),
          JSON.stringify(serializedPacket),
        );
      };

      if (subscriptionsCount <= 0) {
        this.subClient.subscribe(
          responseChannel,
          (err: any) => {
            console.error(`Subscription error: ${err}`)
            console.error(err)

            this.logger.error('Subscription error');
            this.logger.error(err);
            !err && publishPacket();
          }
        );
      } else {
        publishPacket();
      }

      return () => {
        this.unsubscribeFromChannel(responseChannel);
        this.routingMap.delete(packet.id);
      };
    } catch (err) {
      callback({ err });
    }
  }

  protected dispatchEvent(packet: ReadPacket): Promise<any> {
    const pattern = this.normalizePattern(packet.pattern);
    const serializedPacket = this.serializer.serialize(packet);

    return new Promise<void>((resolve, reject) =>
      this.pubClient.publish(pattern, JSON.stringify(serializedPacket), err =>
        err ? reject(err) : resolve(),
      ),
    );
  }

  protected unsubscribeFromChannel(channel: string) {
    const subscriptionCount = this.subscriptionsCount.get(channel);
    this.subscriptionsCount.set(channel, subscriptionCount - 1);

    if (subscriptionCount - 1 <= 0) {
      this.subClient.unsubscribe(channel);
    }
  }
}
