declare module "proper-lockfile" {
  const lockfile: {
    lock(file: string, options: {
      realpath: boolean;
      stale: number;
      update: number;
      retries: number;
      onCompromised(error: Error): void;
    }): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
