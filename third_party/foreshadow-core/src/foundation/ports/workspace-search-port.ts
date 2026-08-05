export interface RgOptions {
  query: string;
  path?: string;
  ignoreCase?: boolean;
  smartCase?: boolean;
  wordMatch?: boolean;
  fixedStrings?: boolean;
  fileType?: string;
  invertMatch?: boolean;
  maxResults?: number;
  glob?: string;
}

export interface RgMatch {
  file: string;
  line: number;
  column: number;
  content: string;
}

export interface RgResult {
  success: boolean;
  matches: RgMatch[];
  error?: string;
}

export interface WorkspaceSearchPort {
  search(options: RgOptions): Promise<RgResult>;
}
