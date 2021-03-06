
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import moment from "moment"
import chalk from "chalk"
import { LOG_DATETIME_FORMAT } from "./constants"

export function isPowerOf(x: number, n: number):boolean {
  const a = Math.log(x) / Math.log(n);
  return Math.pow(a, n) == x;
}

export function toArray<T>(value: T | T[]): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === null || value === undefined ? [] : [value]
}

export function some<T>(iterator: Iterator<T>, pred: (value: T) => boolean): boolean {
  while (true) {
    const { value, done } = iterator.next();
    if (done) {
      break;
    }
    if (pred(value)) {
      return true;
    }
  }
  return false;
}

export function every<T>(iterator: Iterator<T>, pred: (value: T) => boolean): boolean {
  while (true) {
    const { value, done } = iterator.next();
    if (done) {
      break;
    }
    if (!pred(value)) {
      return false;
    }
  }
  return true;
}

export function* filter<T>(iterator: Iterator<T>, pred: (value: T) => boolean): IterableIterator<T> {
  while (true) {
    const { value, done } = iterator.next();
    if (done) {
      break;
    }
    if (pred(value)) {
      yield value;
    }
  }
}

export function* map<T, R>(iterator: Iterator<T>, func: (value: T) => R): IterableIterator<R> {
  while (true) {
    const { value, done } = iterator.next();
    if (done) {
      break;
    }
    yield func(value);
  }
}

export function* flatMap<T, R>(iterator: Iterator<T>, func: (value: T) => IterableIterator<R>): IterableIterator<R> {
  while (true) {
    const { value, done } = iterator.next();
    if (done) {
      break;
    }
    for (const element of func(value)) {
      yield element;
    }
  }
}

export function pushAll<T>(array: T[], elements: T[]) {
  for (const element of elements) {
    array.push(element);
  }
}

export function comparator<T>(pred: (a: T, b: T) => boolean): (a: T, b: T) => number {
  return function (a, b) {
    if (pred(a, b)) {
      return 1;
    } else if (pred(b, a)) {
      return -1;
    } else {
      return 0;
    }
  }
}

export function assert(test: boolean): asserts test  {
  if (!test) {
    throw new Error(`Invariant violation: an internal sanity check failed. See the stack trace for details.`);
  }
}

export interface JsonArray extends Array<Json> {  };
export interface JsonObject { [key: string]: Json }
export type Json = null | string | boolean | number | JsonArray | JsonObject;

export function isInsideDirectory(filepath: string, rootDir: string): boolean {
  const relPath = path.relative(rootDir, filepath)
  return !relPath.startsWith('..');
}

export function stripExtensions(filepath: string) {
  const i = filepath.indexOf('.')
  return i !== -1
    ? filepath.substring(0, i)
    : filepath;
}

export function isString(value: any): value is string {
  return typeof(value) === 'string';
}

export function hasOwnProperty<T extends object, K extends PropertyKey>(obj: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function countDigits(x: number, base: number = 10) {
  if (x === 0) {
    return 1
  }
  return Math.ceil(Math.log(x+1) / Math.log(base))
}

export function uniq<T>(elements: T[]): T[] {
  const out: T[] = [];
  const visited = new Set<T>();
  for (const element of elements) {
    if (visited.has(element)) {
      continue;
    }
    visited.add(element);
    out.push(element);
  }
  return out;
}

function getTag(value: any) {
  if (value == null) {
    return value === undefined ? '[object Undefined]' : '[object Null]'
  }
  return toString.call(value)
}

function isObjectLike(value: any) {
  return typeof value === 'object' && value !== null;
}

export function isPlainObject(value: any): value is MapLike<any> {
  if (!isObjectLike(value) || getTag(value) != '[object Object]') {
    return false
  }
  if (Object.getPrototypeOf(value) === null) {
    return true
  }
  let proto = value
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto)
  }
  return Object.getPrototypeOf(value) === proto
}

export function* values<T extends object>(obj: T): IterableIterator<T[keyof T]> {
  for (const key of Object.keys(obj)) {
    yield obj[key as keyof T];
  }
}

export function mapValues<T extends object, R>(obj: T, func: (value: T[keyof T]) => R): { [K in keyof T]: R } {
  const newObj: any = {}
  for (const key of Object.keys(obj)) {
    newObj[key as keyof T] = func(obj[key as keyof T]);
  }
  return newObj;
}

export const prettyPrintTag = Symbol('pretty printer');

export function prettyPrint(value: any): string {
  if (isObjectLike(value) && value[prettyPrintTag] !== undefined) {
    return value[prettyPrintTag]();
  }
  return value.toString();
}

export type Newable<T> = {
  new(...args: any): T;
}

export function isPrimitive(value: any): boolean {
  return (typeof(value) !== 'function' && typeof(value) !== 'object') || value === null;
}

export const serializeTag = Symbol('serialize tag');
export const deserializeTag = Symbol('deserialize tag');

const deserializableClasses = new Map<string, Newable<{ [serializeTag](): Json }>>();

export function registerClass(cls: Newable<any>) {
  deserializableClasses.set(cls.name, cls)
}

const TYPE_KEY = '__type'

export function serialize(value: any): Json {
  if (isPrimitive(value)) {
    if (typeof(value) === 'bigint') {
      return {
        [TYPE_KEY]: 'bigint',
        value: value.toString(),
      } 
    } else {
      return value;
    }
  } else if (Array.isArray(value)) {
    return value.map(serialize);
  } else if (isObjectLike(value)) {
    if (isPlainObject(value)) {
      const result: MapLike<Json> = {};
      for (const key of Object.keys(value)) {
        result[key] = serialize(value[key]);
      }
      return result;
    } else if (value[serializeTag] !== undefined
        && typeof(value[serializeTag]) === 'function'
        && typeof(value.constructor.name) === 'string') {
      return {
        [TYPE_KEY]: 'classinstance',
        name: value.constructor.name,
        args: value[serializeTag]().map(serialize),
      }
    } else {
      throw new Error(`Could not serialize ${value}: it was a non-primitive object and has no serializer tag.`)
    }
  } else {
    throw new Error(`Could not serialize ${value}: is was not recognised as a primitive type, an object, a class instance, or an array.`)
  }
}

export function deserialize(data: Json): any {
  if (isPrimitive(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(deserialize);
  }
  if (isPlainObject(data)) {
    if (data[TYPE_KEY] === 'bigint') {
      return BigInt(data.value);
    }
    if (data[TYPE_KEY] === 'classinstance') {
      const cls = deserializableClasses.get(data.name as string);
      if (cls === undefined) {
        throw new Error(`Could not deserialize ${data.name}: class not found.`)
      }
      const args = (data.args as JsonArray).map(deserialize);
      return new cls(...args)
    }
    const result: MapLike<any> = {};
    for (const key of Object.keys(data)) {
      result[key] = deserialize(data[key]);
    }
    return result;
  }
  throw new Error(`I did not know how to deserialize ${data}'.`)
}

export function deserializable() {
  return function (target: any) {
    deserializableClasses.set(target.name, target);
  }
}

export type Ref<T extends object = any> = T & {
  replaceWith(value: T): void;
  cloneRef(): Ref<T>;
}

const refSymbolTag = Symbol('is reference');

export function isRef<T extends object>(value: T): value is Ref<T> {
  return typeof(value) === 'object'
      && value !== null
      && (value as any)[refSymbolTag] !== undefined
}

export const getKeyTag = Symbol('get key of object');

function getKey(value: any): string {
  if (typeof(value) === 'string') {
    return value;
  } else if (typeof(value) === 'number') {
    return value.toString();
  } else if (isObjectLike(value) && hasOwnProperty(value, getKeyTag)) {
    return value[getKeyTag]();
  } else {
    throw new Error(`Could not calculate a key for ${value}`);
  }
}

class EmptyIterator implements IterableIterator<any> {

  public [Symbol.iterator]() {
    return this;
  }

  public next() {
    return {
      done: undefined,
      value: undefined
    } as IteratorYieldResult<any>;
  }

}

export class FastMultiMap<K, V> {

  private mapping = Object.create(null);

  public size = 0;

  public clear(): void {
    this.mapping = Object.create(null);
  }

  public *get(key: K): Iterable<V> {
    if (this.mapping[key] !== undefined) {
      yield* this.mapping[key];
    }
  }

  public add(key: K, value: V) {
    const keyStr = getKey(key);
    if (keyStr in this.mapping) {
      this.mapping[keyStr].push(value);
    } else {
      this.mapping[keyStr] = [ value ]
    }
    this.size++;
  }

  public *values(): Iterable<V> {
    for (const key of Object.keys(this.mapping)) {
      yield* this.mapping[key];
    }
  }

  public has(key: K): boolean {
    return key in this.mapping;
  }

  public *[Symbol.iterator]() {
    for (const key of Object.keys(this.mapping)) {
      for (const element of this.mapping[key]) {
        yield [key, element];
      }
    }
  }

}

export class FastStringMap<K extends PropertyKey, V> {

  private mapping = Object.create(null);

  constructor(elements: Iterable<[K, V]> = []) {
    for (const [k, v] of elements) {
      this.add(k, v);
    }
  }

  public clear(): void {
    this.mapping.clear();
  }

  public add(key: K, value: V): void {
    if (key in this.mapping) {
      throw new Error(`Key '${key}' already exists in this mapping.`);
    }
    this.mapping[key] = value;
  }

  public set(key: K, value: V): void {
    this.mapping[key] = value;
  }

  public *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const key of Object.keys(this.mapping)) {
      yield [key as K, this.mapping[key]];
    }
  }

  public get(key: K): V {
    if (!(key in this.mapping)) {
      throw new Error(`No value found for key '${key}'.`);
    }
    return this.mapping[key];
  }

  public *keys(): IterableIterator<K> {
    for (const key of Object.keys(this.mapping)) {
      yield key as K;
    }
  }

  public *values(): IterableIterator<V> {
    for (const key of Object.keys(this.mapping)) {
      yield this.mapping[key];
    }
  }

  //public set(key: K, value: V): void {
  //  if (key in this.mapping) {
  //    throw new Error(`A value for key '${key}' already exists.`);
  //  }
  //  this.mapping[key] = value
  //}

  public has(key: K): boolean {
    return key in this.mapping;
  }

  public delete(key: K): void {
    if (!(key in this.mapping)) {
      throw new Error(`No value found for key '${key}'.`);
    }
    delete this.mapping[key];
  }

}

class DeepMap {

  private rootMap = new Map<any, any>();

  public has(key: any[]) {
    let curr = this.rootMap;
    for (const element of key) {
      if (!curr.has(element)) {
        return false;
      }
      curr = curr.get(element)!;
    }
    return true;
  }

  public get(key: any[]) {
    let curr = this.rootMap;
    for (const element of key) {
      if (!curr.has(element)) {
        return;
      }
      curr = curr.get(element)!;
    }
    return curr;
  }

  public set(key: any[], value: any) {
    let curr = this.rootMap;
    for (const element of key.slice(0, -1)) {
      if (!curr.has(element)) {
        curr.set(element, new Map());
      }
      curr = curr.get(element)!;
    }
    curr.set(key[key.length-1], value);
  }

}

export function memoize(hasher: (...args: any[]) => string) {
  return function (target: any, key: PropertyKey) {
    const origMethod = target[key];
    target[key] = function wrapper(...args: any[]) {
      if (this.__MEMOIZE_CACHE === undefined) {
        this.__MEMOIZE_CACHE = Object.create(null);
      }
      if (this.__MEMOIZE_CACHE[key] === undefined) {
        this.__MEMOIZE_CACHE[key] = Object.create(null);
      }
      const hashed = hasher(...args);
      const cache = this.__MEMOIZE_CACHE[key];
      if (hashed in cache) {
        return cache[hashed];
      }
      const result = origMethod.apply(this, args);
      cache[hashed] = result;
      return result;
    }
    return target;
  }
}

export interface Stream<T> {
  get(): T;
  peek(count?: number): T;
  fork(): Stream<T>;
  join(forked: Stream<T>): void;
}

export class GeneratorStream<T> implements Stream<T> {

  public constructor(
    protected generate: () => T,
    private buffer: T[] = [],
    private offset = 0,
  ) {

  }

  public get() {
    while (this.buffer.length <= this.offset) {
      this.buffer.push(this.generate());
    }
    return this.buffer[this.offset++];
  }

  public peek(i = 1) {
    const offset = this.offset + i;
    while (this.buffer.length < offset) {
      this.buffer.push(this.generate());
    }
    return this.buffer[offset-1];
  }

  public fork(): GeneratorStream<T> {
    return new GeneratorStream(this.generate, this.buffer, this.offset);
  }

  public join(other: GeneratorStream<T>) {
    this.offset = Math.max(this.offset, other.offset);
  }

}

export class StreamWrapper<T> {

  constructor(
    protected data: T[],
    protected createSentry: () => T,
    protected offset = 0
  ) {

  }

  public peek(count = 1) {
    const offset = this.offset + (count - 1);
    if (offset >= this.data.length) {
      return this.createSentry();
    }
    return this.data[offset];
  }

  public get() {
    if (this.offset >= this.data.length) {
      return this.createSentry();
    }
    return this.data[this.offset++];
  }

  public fork() {
    return new StreamWrapper(this.data, this.createSentry, this.offset);
  }

  public join(other: StreamWrapper<T>) {
    this.offset = Math.max(this.offset, other.offset);
  }

}

export const inspectTag = require('util').inspect.custom;

export function indent(text: string, indentation = '  ', afterNewLine = true) {
  let out = ''
  for (const ch of text) {
    if (ch === '\n') {
      afterNewLine = true;
      out += ch;
    } else {
      if (afterNewLine && !/[\t ]/.test(ch)) {
        out += indentation;
        afterNewLine = false;
      }
      out += ch;
    }
  }
  return out;
}

export function expandPath(filepath: string) {
  let out = ''
  for (const ch of filepath) {
    if (ch === '~') {
      out += os.homedir();
    } else {
      out += ch;
    }
  }
  return out;
}

export function verbose(message: string) {
  console.error(chalk.gray('[') + chalk.magenta('verb') + ' ' + chalk.gray(moment().format(LOG_DATETIME_FORMAT) + ']') + ' ' + message);
}

export function warn(message: string) {
  console.error(chalk.gray('[') + chalk.red('warn') + ' ' + chalk.gray(moment().format(LOG_DATETIME_FORMAT) + ']') + ' ' + message);
}

export function error(message: string) {
  console.error(chalk.gray('[') + chalk.red('erro') + ' ' + chalk.gray(moment().format(LOG_DATETIME_FORMAT) + ']') + ' ' + message);
}

export function upsearchSync(filenames: string[], startDir = '.') {
  let currDir = startDir;
  while (true) {
    for (const filename of filenames) {
      const filePath = path.join(currDir, filename);
      if (fs.existsSync(filePath)) {
        return filePath
      }
    }
    const { root, dir } = path.parse(currDir);
    if (currDir === root) {
      return null;
    }
    currDir = dir;
  }
}

export function getFileStem(filepath: string): string {
  return path.basename(filepath).split('.')[0];
}

export function enumOr(elements: string[]) {
  if (elements.length === 1) {
    return elements[0]
  } else {
    return elements.slice(0, elements.length-1).join(', ') + ' or ' + elements[elements.length-1]
  }
}

export function escapeChar(ch: string) {
  switch (ch) {
    case '\a': return '\\a';
    case '\b': return '\\b';
    case '\f': return '\\f';
    case '\n': return '\\n';
    case '\r': return '\\r';
    case '\t': return '\\t';
    case '\v': return '\\v';
    case '\0': return '\\0';
    case '\'': return '\\\'';
    default:
      const code = ch.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7E)  {
        return ch
      } else if (code < 0x7F) {
        return `\\x${code.toString(16).padStart(2, '0')}`
      } else {
        return `\\u${code.toString(16).padStart(4, '0')}`
      }
  }
}

export interface MapLike<T> {
  [key: string]: T;
}

export type FormatArg = any;

enum FormatScanMode {
  Text,
  ScanningParamName,
  ScanningParamModifier,
}

type FormatModifierFn = (value: any) => any;

const FORMAT_MODIFIERS: MapLike<FormatModifierFn> = {
  enum(elements) {
    return enumOr(elements);
  },
  pretty(value) {
    return value.map(prettyPrint);
  },
  join(elements) {
    return elements.map(prettyPrint).join(', ');
  }
}

export function format(message: string, data: MapLike<FormatArg>) {

  let out = ''

  let path: string[] = [];
  let name = '';
  let modifierName = '';
  let modifiers: string[] = [];
  let mode = FormatScanMode.Text;

  for (const ch of message) {
    switch (mode) {
      case FormatScanMode.ScanningParamModifier:
        if (ch === '}') {
          if (modifierName.length === 0) {
            throw new Error(`Parameter modfifier name in format string is empty.`)
          }
          modifiers.push(modifierName);
          push();
        } else if (ch === ':') {
          if (modifierName.length > 0) {
            modifiers.push(modifierName);
            modifierName = '';
          }
        } else {
          modifierName += ch;
        }
        break;
      case FormatScanMode.ScanningParamName:
        if (ch === '}') {
          push();
        } else if (ch === ':') {
          mode = FormatScanMode.ScanningParamModifier; 
        } else if (ch === '.') {
          path.push(name);
          name = '';
        } else {
          name += ch;
        }
        break;
      case FormatScanMode.Text:
        if (ch === '{') {
          mode = FormatScanMode.ScanningParamName;
        } else {
          out += ch;
        }
        break
      default:
        throw new Error(`Invalid format scanning mode.`)
    }
  }

  return out;

  function push() {
    let value = data;
    for (const pathElement of path) {
      value = value[pathElement];
    }
    value = value[name];
    if (value === undefined) {
      throw new Error(`Format string requires key '${name}' but it was not provided.`)
    }
    for (const modifier of modifiers) {
      const modifierFn = FORMAT_MODIFIERS[modifier];
      if (modifierFn === undefined) {
        throw new Error(`A format modifier named '${modifier}' was not found.`)
      }
      value = modifierFn(value);
    }
    out += prettyPrint(value);
    reset();
  }

  function reset() {
    path = [];
    name = '';
    modifierName = '';
    mode = FormatScanMode.Text;
    modifiers = [];
  }

}

export function deepEqual(a: any, b: any): boolean {
  if (isPrimitive(a) && isPrimitive(b)) {
    return a === b;
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  } else if (isPlainObject(a) && isPlainObject(b)) {
    const unmarked = new Set(Object.keys(b));
    for (const key of Object.keys(a)) {
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
      unmarked.delete(key);
    }
    return unmarked.size === 0;
  }
  return false;
}
