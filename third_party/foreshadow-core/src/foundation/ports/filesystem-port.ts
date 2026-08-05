export interface FileSystemPort {
  exists(path: string): boolean;
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  writeFile(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readFileSync?(path: string, encoding?: BufferEncoding): string;
  writeFileSync?(path: string, content: string, encoding?: BufferEncoding): void;
}
