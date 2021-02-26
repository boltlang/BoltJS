
import { BoltBindPattern, isBoltBlockExpression, isBoltFunctionDeclaration, isBoltFunctionExpression, isBoltSourceFile, kindToString, SourceFile, Syntax, SyntaxKind } from "./ast";
import { Syntax } from "./ast-spec";
import { getSymbolText } from "./common";
import { assert, FastStringMap } from "./util";

enum TypeKind {
  TypeVar,
  PrimType,
  ArrowType,
}

type Type
  = TypeVar
  | PrimType
  | ArrowType

interface TypeBase {
  kind: TypeKind;
}

function createGenerator(defaultPrefix: string) {
  const counts = Object.create(null);
  return function (prefix = defaultPrefix) {
    const count = counts[prefix];
    if (count !== undefined) {
      counts[prefix]++;
      return prefix + count;
    }
    counts[prefix] = 1;
    return prefix + '0';
  }
}

const generateTypeVarId = createGenerator('a');

class TypeVar implements TypeBase {

  public readonly kind: TypeKind.TypeVar = TypeKind.TypeVar;

  public varId: string;

  constructor(public hint?: string) {
    this.varId = generateTypeVarId(hint);
  }

  public hasTypeVariable(typeVar: TypeVar): boolean {
    return typeVar.varId === this.varId;
  }

  public applySubstitution(substitution: TypeVarSubstitution): Type {
    if (substitution.has(this)) {
      return substitution.get(this);
    } else {
      return this;
    }
  }

  public format() {
    return this.varId;
  }

}

class PrimType implements TypeBase {

  public readonly kind: TypeKind.PrimType = TypeKind.PrimType;

  constructor(
    public primId: number,
    public displayName: string,
  ) {

  }

  public hasTypeVariable(typeVar: TypeVar): boolean {
    return false;
  }

  public applySubstitution(substitution: TypeVarSubstitution) {
    return this;
  }

  public format() {
    return this.displayName;
  }

}

class ArrowType implements TypeBase {

  public readonly kind: TypeKind.ArrowType = TypeKind.ArrowType;

  constructor(
    public paramTypes: Type[],
    public returnType: Type
  ) {

  }

  public hasTypeVariable(typeVar: TypeVar): boolean {
    return this.paramTypes.some(paramType => paramType.hasTypeVariable(typeVar))
        || this.returnType.hasTypeVariable(typeVar);
  }

  public applySubstitution(substitution: TypeVarSubstitution): Type {
    return new ArrowType(
      this.paramTypes.map(type => type.applySubstitution(substitution)),
      this.returnType.applySubstitution(substitution)
    )
  }

  public format(): string {
    return `(${this.paramTypes.map(type => type.format()).join(', ')}) -> ${this.returnType.format()}`
  }

}

function getFreeVariablesOfType(type: Type): TypeVarSet {

  const freeVariables = new TypeVarSet();

  const visit = (type: Type) => {

    switch (type.kind) {

      case TypeKind.TypeVar:
        freeVariables.add(type);
        break;

      case TypeKind.PrimType:
        break;

      case TypeKind.ArrowType:
        for (const paramType of type.paramTypes) {
          visit(paramType);
        }
        visit(type.returnType);
        break;

      default:
        throw new Error(`Could not get the free type variables: unknown type kind`);

    }

  }

  visit(type);

  return freeVariables;

}

class TypeVarSubstitution {

  private mapping = new FastStringMap<string, [TypeVar, Type]>();

  public add(source: TypeVar, target: Type) {
    if (this.mapping.has(source.varId)) {
      throw new Error(`Could not add type variable to substitution: variable ${source.varId} already exists.`)
    }
    this.mapping.set(source.varId, [source, target]);
  }

  public has(source: TypeVar): boolean {
    return this.mapping.has(source.varId);
  }

  public compose(other: TypeVarSubstitution): TypeVarSubstitution {
    const newSubstitution = new TypeVarSubstitution();
    for (const [typeVar, type] of other) {
      newSubstitution.add(typeVar, type.applySubstitution(this));
    }
    for (const [typeVar, type] of this) {
      newSubstitution.add(typeVar, type);
    }
    return newSubstitution;
  }

  public defaults(other: TypeVarSubstitution): void{ 
    for (const [name, entry] of other.mapping) {
      if (!this.mapping.has(name)) {
        this.mapping.set(name, entry);
      }
    }
  }

  public get(source: TypeVar): Type {
    return this.mapping.get(source.varId)[1];
  }

  public *[Symbol.iterator](): Iterator<[TypeVar, Type]> {
    for (const [source, target] of this.mapping.values()) {
      yield [source, target];
    }
  }

}

const emptyTypeVarSubstitution = new TypeVarSubstitution();

class TypeVarSet {

  private typeVarIds = new FastStringMap<string, TypeVar>();

  constructor(iterable: Iterable<TypeVar> = []) {
    for (const typeVar of iterable) {
      this.add(typeVar);
    }
  }

  public add(typeVar: TypeVar): void {
    this.typeVarIds.set(typeVar.varId, typeVar);
  }

  public has(typeVar: TypeVar): boolean {
    return this.typeVarIds.has(typeVar.varId);
  }

  public delete(typeVar: TypeVar): void {
    this.typeVarIds.delete(typeVar.varId);
  }

  public [Symbol.iterator]() {
    return this.typeVarIds.values();
  }

}

class ForallScheme {

  constructor(
    public typeVars: TypeVarSet,
    public type: Type,
  ) {

  }

  public getFreeVariables(): TypeVarSet {
    const freeVariables = getFreeVariablesOfType(this.type);
    for (const typeVar of this.typeVars) {
      freeVariables.delete(typeVar);
    }
    return freeVariables;
  }

  public applySubstitution(substitution: TypeVarSubstitution): Scheme {
    const newSubstitution = new TypeVarSubstitution();
    for (const [typeVar, mappedType] of substitution) {
      if (!this.typeVars.has(typeVar)) {
        newSubstitution.add(typeVar, mappedType);
      }
    }
    return new ForallScheme(
      this.typeVars,
      this.type.applySubstitution(newSubstitution)
    );
  }

}

type Scheme
  = ForallScheme

type Constraint = [Type, Type]

export class TypeEnv {

  private mapping = new FastStringMap<string, Scheme>();

  public set(name: string, scheme: Scheme) {
    this.mapping.set(name, scheme)
  }

  public remove(name: string): void {
    this.mapping.delete(name)
  }

  public lookup(name: string): Type | null {
    if (!this.mapping.has(name)) {
      return null;
    }
    const scheme = this.mapping.get(name);
    const freshVars = new TypeVarSubstitution();
    for (const typeVar of scheme.typeVars) {
      freshVars.add(typeVar, new TypeVar())
    }
    return scheme.type.applySubstitution(freshVars);
  }

  public has(typeVar: TypeVar): boolean {
    return this.mapping.has(typeVar.varId)
  }

  public clone(): TypeEnv {
    const result = new TypeEnv();
    for (const [name, scheme] of this.mapping) {
      result.set(name, scheme);
    }
    return result;
  }

  public getFreeVariables(): TypeVarSet {
    const freeVariables = new TypeVarSet();
    for (const scheme of this.mapping.values()) {
      for (const typeVar of scheme.getFreeVariables()) {
        freeVariables.add(typeVar);
      }
    }
    return freeVariables;
  }

}

function generalizeType(type: Type, typeEnv: TypeEnv): Scheme {
  const freeVariables = getFreeVariablesOfType(type);
  for (const varName of typeEnv.getFreeVariables()) {
    freeVariables.delete(varName)
  }
  return new ForallScheme(freeVariables, type);
}

function bindTypeVar(typeVar: TypeVar, type: Type): TypeVarSubstitution {
  if (type.kind === TypeKind.TypeVar && type.varId === typeVar.varId) {
    return emptyTypeVarSubstitution;
  }
  if (type.hasTypeVariable(typeVar)) {
    throw new Error(`Type ${type.format()} has ${typeVar.format()} as an unbound free type variable.`);
  }
  const substitution = new TypeVarSubstitution();
  substitution.add(typeVar, type);
  return substitution
}

function getNodeIntroducingScope(node: Syntax) {
  let currNode: Syntax | null = node;
  while (true) {
    if (isBoltSourceFile(currNode)
    || isBoltBlockExpression(currNode)
    || isBoltFunctionDeclaration(currNode)
    || (isBoltFunctionExpression(currNode) && currNode.body !== null)) {
      return currNode;
    }
    if (currNode!.parentNode === null) {
      return currNode;
    }
    currNode = currNode!.parentNode;
  }
}

export class TypeCheckError extends Error {

}

export class UnificationError extends TypeCheckError {
  constructor(public left: Type, public right: Type) {
    super(`Type ${left.format()} could not be unified with ${right.format()}.`)
  }
}

export class TypeNotFoundError extends TypeCheckError {
  constructor(public node: Syntax, public typeName: string) {
    super(`A type named '${typeName}' could not be found.`);
  }
}

export class ParamCountMismatchError extends TypeCheckError {
  constructor(public a: ArrowType, public b: ArrowType) {
    super(`${a.format()} accepts ${a.paramTypes.length} arguments while ${b.format()} accepts ${b.paramTypes.length}`);
  }
}

export class BindingNotFoundError extends TypeCheckError {
  constructor(public node: Syntax, public varName: string) {
    super(`A binding named '${varName}' was not found.`);
  }
}

export class TypeChecker {

  private nextPrimTypeId = 1;

  private intType = this.createPrimType('int');
  private stringType = this.createPrimType('String');
  private boolType = this.createPrimType('bool');

  private nodeToTypeEnv = new FastStringMap<number, TypeEnv>();

  public isIntType(type: Type) {
    return type === this.intType;
  }

  public isStringType(type: Type) {
    return type === this.stringType;
  }

  private builtinTypes = new FastStringMap<string, Type>([
    ['int', this.intType],
    ['String', this.stringType],
    ['bool', this.boolType]
  ]);

  private createPrimType(name: string): PrimType {
    return new PrimType(this.nextPrimTypeId++, name);
  }

  public registerSourceFile(sourceFile: SourceFile): void {
    const typeEnv = new TypeEnv();
    for (const element of sourceFile.elements) {
      this.checkNode(element, typeEnv);
    }
    this.nodeToTypeEnv.set(sourceFile.id, typeEnv);
  }

  private applySubstitutionToConstraints(constraints: Constraint[], substitution: TypeVarSubstitution): void {
    for (let i = 0; i < constraints.length; i++) {
      const constraint = constraints[i];
      constraint[0] = constraint[0].applySubstitution(substitution)
      constraint[1] = constraint[1].applySubstitution(substitution)
    }
  }

  private visitBinding(node: BoltBindPattern, type: Type, typeEnv: TypeEnv) {
    switch (node.kind) {
      case SyntaxKind.BoltBindPattern:
        {
          const varName = node.name.text;
          typeEnv.set(varName, new ForallScheme([], type));
          break;
        }
    }
  }

  private inferNode(node: Syntax, typeEnv: TypeEnv, constraints: Constraint[]): Type {

    switch (node.kind) {

      case SyntaxKind.BoltReferenceTypeExpression:
      {
        assert(node.name.modulePath.length === 0);
        const typeName = getSymbolText(node.name.name);
        if (!this.builtinTypes.has(typeName)) {
          throw new TypeNotFoundError(node, typeName);
        }
        return this.builtinTypes.get(typeName);
      }

      case SyntaxKind.BoltVariableDeclaration:
      {
        const varName = (node.bindings as BoltBindPattern).name.text;
        const localConstraints = [...constraints];
        const typeVar = new TypeVar();
        if (node.typeExpr !== null) {
          const typeExprType = this.inferNode(node.typeExpr, typeEnv, localConstraints);
          localConstraints.push([ typeVar, typeExprType ]);
        }
        if (node.value !== null) {
          const valueType = this.inferNode(node.value, typeEnv, localConstraints);
          localConstraints.push([ typeVar, valueType ])
        }
        const substitution = this.solveConstraints(localConstraints);
        const resultType = typeVar.applySubstitution(substitution);
        typeEnv.set(varName, generalizeType(resultType, typeEnv));
        return resultType;
      }

      case SyntaxKind.BoltConstantExpression:
      {
        if (typeof(node.value) === 'bigint') {
          return this.intType;
        } else if (typeof(node.value === 'string')) {
          return this.stringType;
        } else if (typeof(node.value) === 'boolean') {
          return this.boolType;
        } else {
          throw new Error(`Could not infer type of BoltConstantExpression`)
        }
      }

      case SyntaxKind.BoltReferenceExpression:
      {
        const varName = getSymbolText(node.name.name);
        if (varName === '+') {
          return new ArrowType([ this.intType, this.intType ], this.intType);
        }
        if (varName === '-') {
          return new ArrowType([ this.intType, this.intType ], this.intType);
        }
        if (varName === '-') {
          return new ArrowType([ this.intType, this.intType ], this.intType);
        }
        if (varName === '*') {
          return new ArrowType([ this.intType, this.intType ], this.intType);
        }
        const type = typeEnv.lookup(varName);
        if (type === null) {
          throw new BindingNotFoundError(node, varName);
        }
        return type!;
      }

      case SyntaxKind.BoltCallExpression:
      {
        const operatorType = this.inferNode(node.operator, typeEnv, constraints)
        const operandTypes = [];
        for (const operand of node.operands) {
          const operandType = this.inferNode(operand, typeEnv, constraints);
          operandTypes.push(operandType)
        }
        const returnType = new TypeVar();
        constraints.push([
          operatorType,
          new ArrowType(operandTypes, returnType)
        ])
        return returnType;
      }

      case SyntaxKind.BoltFunctionExpression:
      {
        const tvs = [];
        const newEnv = typeEnv.clone();
        for (const param of node.params) {
          const tv = new TypeVar();
          tvs.push(tv)
          const x = (param.bindings as BoltBindPattern).name.text;
          newEnv.set(x, new ForallScheme(new TypeVarSet(), tv))
        }
        const returnType = this.inferNode(node.expression!, newEnv, constraints);
        return new ArrowType(
          tvs,
          returnType
        );
      }

      default:
        throw new Error(`Could not infer type of node ${kindToString(node.kind)}`)

    }

  }

  public checkNode(node: Syntax, typeEnv: TypeEnv): void {
    switch (node.kind) {
      case SyntaxKind.BoltExpressionStatement:
        this.inferNode(node.expression, typeEnv, []);
        break;
      case SyntaxKind.BoltVariableDeclaration:
        this.inferNode(node, typeEnv, []);
        break;
      case SyntaxKind.BoltAssignStatement:
        const varName = (node.lhs as BoltBindPattern).name.text;
        const lhsType = typeEnv.lookup(varName);
        if (lhsType === null) {
          throw new BindingNotFoundError(node, varName)
        }
        const rhsType = this.getTypeOfNode(node.rhs, typeEnv);
        this.solveConstraints([[ lhsType, rhsType ]])
        break;
    }
  }

  private solveConstraints(constraints: Constraint[]): TypeVarSubstitution {
    let substitution = new TypeVarSubstitution();
    while (true) {
      if (constraints.length === 0) {
        return substitution;
      }
      const [a, b] = constraints.pop()!;
      const newSubstitution = this.unifies(a, b);
      substitution = newSubstitution.compose(substitution);
      this.applySubstitutionToConstraints(constraints, newSubstitution);
    }
  }

  private areTypesEqual(a: Type, b: Type): boolean {
    if (a === b) { 
      return true;
    }
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === TypeKind.PrimType && b.kind === TypeKind.PrimType) {
      return a.primId === b.primId;
    }
    if (a.kind === TypeKind.ArrowType && b.kind === TypeKind.ArrowType) {
      if (a.paramTypes.length !== b.paramTypes.length
          || !this.areTypesEqual(a.returnType, b.returnType)) {
        return false;
      }
      for (let i = 0; i < a.paramTypes.length; i++) {
        if (!this.areTypesEqual(a.paramTypes[i], b.paramTypes[i])) {
          return false;
        }
      }
      return true;
    }
    if (a.kind === TypeKind.TypeVar && b.kind === TypeKind.TypeVar) {
      return a.varId === b.varId;
    }
    throw new Error(`Unexpected combination of types while checking equality`)
  }

  private unifies(a: Type, b: Type): TypeVarSubstitution {
    if (this.areTypesEqual(a, b)) {
      return new TypeVarSubstitution();
    }
    if (a.kind === TypeKind.TypeVar) {
      return bindTypeVar(a, b);
    }
    if (b.kind === TypeKind.TypeVar) {
      return bindTypeVar(b, a);
    }
    if (a.kind === TypeKind.ArrowType && b.kind === TypeKind.ArrowType) {
      if (a.paramTypes.length !== b.paramTypes.length) {
        throw new ParamCountMismatchError(a, b);
      }
      let substitution = new TypeVarSubstitution();
      let returnA = a.returnType;
      let returnB = b.returnType;
      for (let i = 0; i < a.paramTypes.length; i++) {
        const paramSubstitution = this.unifies(a.paramTypes[i], b.paramTypes[i]);
        returnA = returnA.applySubstitution(paramSubstitution);
        returnB = returnB.applySubstitution(paramSubstitution);
        substitution = paramSubstitution.compose(substitution);
      }
      const returnSubstitution = this.unifies(returnA, returnB);
      return returnSubstitution.compose(substitution);
    }
    throw new UnificationError(a, b);
  }

  private getTypeEnvForNode(node: Syntax): TypeEnv {
    const scopeNode = getNodeIntroducingScope(node)
    if (this.nodeToTypeEnv.has(scopeNode.id)) {
      return this.nodeToTypeEnv.get(scopeNode.id)
    }
    const newTypeEnv = new TypeEnv();
    this.nodeToTypeEnv.set(scopeNode.id, newTypeEnv)
    return newTypeEnv;
  }

  public getTypeOfNode(node: Syntax, typeEnv?: TypeEnv): Type {
    if (typeEnv === undefined) {
      typeEnv = this.getTypeEnvForNode(node);
    }
    const constraints: Constraint[] = [];
    const type = this.inferNode(node, typeEnv, constraints);
    const substitution = this.solveConstraints(constraints);
    return type.applySubstitution(substitution);
  }

  public isBuiltinType(name: string) {
    return this.builtinTypes.has(name);
  }

}
