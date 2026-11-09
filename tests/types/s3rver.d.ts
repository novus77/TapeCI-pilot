declare module "s3rver" {
  interface S3rverOptions {
    readonly port?: number;
    readonly address?: string;
    readonly directory: string;
    readonly silent?: boolean;
    readonly configureBuckets?: ReadonlyArray<{ readonly name: string }>;
  }
  interface S3rverAddress {
    readonly address: string;
    readonly port: number;
  }
  export default class S3rver {
    constructor(options: S3rverOptions);
    run(callback?: (error: Error | null, address?: S3rverAddress) => void): Promise<S3rverAddress>;
    close(): Promise<void>;
  }
}
