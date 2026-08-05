import { Location, Position, makePosition } from './geometry';

export enum ArtifactType {
  File = 'File',
  Module = 'Module',
  Namespace = 'Namespace',
  Package = 'Package',
  Class = 'Class',
  Method = 'Method',
  Property = 'Property',
  Field = 'Field',
  Constructor = 'Constructor',
  Enum = 'Enum',
  Interface = 'Interface',
  Function = 'Function',
  Variable = 'Variable',
  Constant = 'Constant',
  String = 'String',
  Number = 'Number',
  Boolean = 'Boolean',
  Array = 'Array',
  Object = 'Object',
  Key = 'Key',
  Null = 'Null',
  EnumMember = 'EnumMember',
  Struct = 'Struct',
  Event = 'Event',
  Operator = 'Operator',
  TypeParameter = 'TypeParameter',
  Terminal = 'Terminal',
  MenuItem = 'MenuItem',
  Unknown = 'Unknown',
}

export const ArtifactTypeCanLogInEdit: ArtifactType[] = [
  ArtifactType.File,
  ArtifactType.Module,
  ArtifactType.Namespace,
  ArtifactType.Package,
  ArtifactType.Class,
  ArtifactType.Enum,
  ArtifactType.Interface,
  ArtifactType.Method,
  ArtifactType.Constructor,
  ArtifactType.Function,
  ArtifactType.Unknown,
];

export interface SymbolRef {
  name: string;
  kind: ArtifactType;
  selectionStart: Position;
  range: { start: Position; end: Position };
  children?: SymbolRef[];
}

export class Artifact {
  constructor(
    public name: string,
    public type: ArtifactType,
    public location?: Location,
    public symbol?: SymbolRef,
    public hierarchy?: Artifact[],
  ) {}

  startPosition(): number {
    return this.location?.range.start.line || 0;
  }

  endPosition(): number {
    return this.location?.range.end.line || 0;
  }

  namePosition(): Position {
    if (this.symbol) {
      return this.symbol.selectionStart;
    }
    console.warn('namePosition of:', this.name, 'is not found');
    return makePosition(0, 0);
  }

  equals(other: Artifact): boolean {
    return this.name === other.name && this.type === other.type;
  }

  equalsByFileName(other: Artifact): boolean {
    return this.hierarchy?.[0]?.name === other.hierarchy?.[0]?.name;
  }

  toJSONObject(): any {
    return {
      name: this.name,
      type: this.type,
      position: `${this.startPosition()}-${this.endPosition()}`,
      hierarchy: this.hierarchy?.map(a => a.toJSONObject()),
    };
  }

  toAbstract(): string {
    if (this.type === ArtifactType.Terminal) {
      return '';
    }
    let abs = '';
    if (this.location) {
      abs += `${this.location.uri.fsPath}:`;
    }
    if (this.type === ArtifactType.File) {
      return abs;
    }
    if (this.hierarchy) {
      abs += `${this.hierarchy.map(a => a.name).join('->')}`;
    } else {
      abs += `${this.name}`;
    }
    abs += ` LineRange: ${this.startPosition()}-${this.endPosition()}`;
    return abs;
  }
}
