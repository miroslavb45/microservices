import { CanActivate, ExceptionFilter, INestMicroservice, NestInterceptor, PipeTransform, WebSocketAdapter } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core/application-config';
import { NestContainer } from '@nestjs/core/injector/container';
import { NestApplicationContext } from '@nestjs/core/nest-application-context';
import { MicroserviceOptions } from './interfaces/microservice-configuration.interface';
export declare class NestMicroservice extends NestApplicationContext implements INestMicroservice {
    private readonly applicationConfig;
    private readonly logger;
    private readonly microservicesModule;
    private readonly socketModule;
    private microserviceConfig;
    private server;
    private isTerminated;
    private isInitHookCalled;
    constructor(container: NestContainer, config: MicroserviceOptions, applicationConfig: ApplicationConfig);
    createServer(config: MicroserviceOptions): void;
    registerModules(): Promise<any>;
    registerListeners(): void;
    useWebSocketAdapter(adapter: WebSocketAdapter): this;
    useGlobalFilters(...filters: ExceptionFilter[]): this;
    useGlobalPipes(...pipes: PipeTransform<any>[]): this;
    useGlobalInterceptors(...interceptors: NestInterceptor[]): this;
    useGlobalGuards(...guards: CanActivate[]): this;
    init(): Promise<this>;
    listen(callback: () => void): void;
    listenAsync(): Promise<any>;
    close(): Promise<any>;
    setIsInitialized(isInitialized: boolean): void;
    setIsTerminated(isTerminated: boolean): void;
    setIsInitHookCalled(isInitHookCalled: boolean): void;
    protected closeApplication(): Promise<any>;
    protected dispose(): Promise<void>;
}
