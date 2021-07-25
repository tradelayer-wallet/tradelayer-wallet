declare class FastifyServer {
      constructor(port: number, optoins: any);
      start(): void;
      stop(reason: string): void;
}

declare module "server-service";