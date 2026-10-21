export interface NativeOpenedRegularFile {
  readonly size: number;
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface NativeBundleRoot {
  openRegular(relativePath: string): Promise<NativeOpenedRegularFile>;
  close(): Promise<void>;
}

export declare function openNativeBundleRoot(
  path: string
): Promise<NativeBundleRoot>;
