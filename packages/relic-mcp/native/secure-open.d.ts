export interface NativeOpenedRegularFile {
  readonly size: number;
  readInto(target: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface NativeBundleRoot {
  openRegular(relativePath: string): Promise<NativeOpenedRegularFile>;
  close(): Promise<void>;
}

export declare function openNativeBundleRoot(
  path: string
): Promise<NativeBundleRoot>;
