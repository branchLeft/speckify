import ts from 'typescript';

/** A checker type, described structurally; see surface.md §3. */
export type TypeNode =
  | { readonly k: 'prim'; readonly name: string }
  | { readonly k: 'lit'; readonly value: string }
  | { readonly k: 'ref'; readonly name: string; readonly args: readonly TypeNode[] }
  | { readonly k: 'union' | 'inter' | 'tuple'; readonly members: readonly TypeNode[] }
  | {
      readonly k: 'obj';
      readonly props: readonly PropNode[];
      readonly calls: readonly SigNode[];
      readonly ctors: readonly SigNode[];
      readonly index: readonly IndexNode[];
    }
  | { readonly k: 'other'; readonly text: string };

export interface PropNode {
  readonly name: string;
  readonly optional: boolean;
  readonly readonly: boolean;
  readonly type: TypeNode;
}

export interface ParamNode {
  readonly optional: boolean;
  readonly rest: boolean;
  readonly type: TypeNode;
}

export interface SigNode {
  readonly typeParams: number;
  readonly params: readonly ParamNode[];
  readonly returns: TypeNode;
}

export interface IndexNode {
  readonly key: TypeNode;
  readonly readonly: boolean;
  readonly type: TypeNode;
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown |
  ts.TypeFlags.String |
  ts.TypeFlags.Number |
  ts.TypeFlags.BigInt |
  ts.TypeFlags.ESSymbol |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never |
  ts.TypeFlags.NonPrimitive;

const NAMED_DECLARATION_FLAGS =
  ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.Enum;

/** Beyond this nesting a type is recorded by its checker name alone. */
const MAX_DEPTH = 40;

const byJson = (a: TypeNode, b: TypeNode): number =>
  JSON.stringify(a).localeCompare(JSON.stringify(b));

function isReadonlyProperty(symbol: ts.Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0
  );
}

/**
 * Describes checker types as {@link TypeNode} trees. A named type below the
 * top level is a reference by name: it is compared as its own export, and
 * describing it again would loop on recursive schemas.
 */
export class TypeDescriber {
  constructor(private readonly checker: ts.TypeChecker) {}

  /** The top-level description of `type`, expanding its own alias or interface body. */
  describe(type: ts.Type): TypeNode {
    return this.node(type, 0, new Set());
  }

  private node(type: ts.Type, depth: number, path: Set<ts.Type>): TypeNode {
    const checker = this.checker;
    if (depth > MAX_DEPTH || path.has(type)) {
      return { k: 'other', text: checker.typeToString(type) };
    }
    const next = (inner: ts.Type): TypeNode =>
      this.node(inner, depth + 1, new Set([...path, type]));

    if (depth > 0 && type.aliasSymbol !== undefined) {
      return {
        k: 'ref',
        name: type.aliasSymbol.name,
        args: (type.aliasTypeArguments ?? []).map(next),
      };
    }
    if ((type.flags & ts.TypeFlags.Boolean) !== 0) return { k: 'prim', name: 'boolean' };
    if (type.isUnion()) return { k: 'union', members: type.types.map(next).sort(byJson) };
    if (type.isIntersection()) return { k: 'inter', members: type.types.map(next).sort(byJson) };
    if ((type.flags & PRIMITIVE_FLAGS) !== 0) {
      return { k: 'prim', name: checker.typeToString(type) };
    }
    if (type.isLiteral() || (type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return { k: 'lit', value: checker.typeToString(type) };
    }
    if ((type.flags & ts.TypeFlags.Object) === 0) {
      return { k: 'other', text: checker.typeToString(type) };
    }
    if (checker.isTupleType(type)) {
      return { k: 'tuple', members: checker.getTypeArguments(type as ts.TypeReference).map(next) };
    }
    const symbol = type.getSymbol();
    const named = symbol !== undefined && (symbol.flags & NAMED_DECLARATION_FLAGS) !== 0;
    if (checker.isArrayType(type) || (named && depth > 0)) {
      const args =
        ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
          ? checker.getTypeArguments(type as ts.TypeReference)
          : [];
      return { k: 'ref', name: symbol?.name ?? 'Array', args: args.map(next) };
    }
    return this.objectNode(type, next);
  }

  private objectNode(type: ts.Type, next: (inner: ts.Type) => TypeNode): TypeNode {
    const checker = this.checker;
    const props = checker
      .getPropertiesOfType(type)
      .map((prop) => ({
        name: prop.name,
        optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
        readonly: isReadonlyProperty(prop),
        type: next(checker.getTypeOfSymbol(prop)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const signature = (sig: ts.Signature): SigNode => ({
      typeParams: sig.getTypeParameters()?.length ?? 0,
      params: sig.getParameters().map((param) => {
        const declaration = param.valueDeclaration;
        const isParam = declaration !== undefined && ts.isParameter(declaration);
        return {
          optional: isParam && checker.isOptionalParameter(declaration),
          rest: isParam && declaration.dotDotDotToken !== undefined,
          type: next(checker.getTypeOfSymbol(param)),
        };
      }),
      returns: next(sig.getReturnType()),
    });
    return {
      k: 'obj',
      props,
      calls: checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(signature),
      ctors: checker.getSignaturesOfType(type, ts.SignatureKind.Construct).map(signature),
      index: checker.getIndexInfosOfType(type).map((info) => ({
        key: next(info.keyType),
        readonly: info.isReadonly,
        type: next(info.type),
      })),
    };
  }
}
