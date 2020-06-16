
import * as path from "path"
import * as fs from "fs-extra"
import { EventEmitter } from "events"
import { sync as globSync } from "glob"

import { Program } from "./program"
import { emitNode } from "./emitter"
import { Syntax, BoltSourceFile, SourceFile, setParents, kindToString, Visitor } from "./ast"
import { getFileStem, MapLike, assert, FastStringMap, upsearchSync } from "./util"
import { verbose, memoize } from "./util"
import { Container, Newable } from "./ioc"
import ExpandBoltTransform from "./transforms/expand"
import CompileBoltToJSTransform from "./transforms/boltToJS"
import ConstFoldTransform from "./transforms/constFold"
import { TransformManager } from "./transforms/index"
import {DiagnosticPrinter, E_PARSE_ERROR, E_STDLIB_NOT_FOUND, E_SSCAN_ERROR as E_SCAN_ERROR, E_NO_BOLTFILE_FOUND_IN_PATH_OR_PARENT_DIRS} from "./diagnostics"
import { TypeChecker } from "./types"
import { CheckInvalidFilePaths, CheckTypeAssignments, CheckReferences } from "./checks"
import { SymbolResolver, BoltSymbolResolutionStrategy } from "./resolver"
import { Evaluator } from "./evaluator"
import { getNodeLanguage, ParseError, ScanError, describeKind } from "./common"
import { Package, loadPackageMetadata } from "./package"
import { TextFile } from "./text"
import { Scanner } from "./scanner"
import { Parser } from "./parser"
import { now } from "moment"

const targetExtensions: MapLike<string> = {
  'JS': '.mjs',
  'Bolt': '.bolt',
  'C': '.c',
};

interface TimingInfo {
  timestamp: number;
  refCount: number;
}

class Timing extends EventEmitter {

  private runningTasks: MapLike<TimingInfo> = Object.create(null);

  public start(name: string) {
    if (this.runningTasks[name] !== undefined) {
      this.runningTasks[name].refCount++;
      return;
    }
    this.runningTasks[name] = { timestamp: now(), refCount: 1 };
    this.emit(`start ${name}`);
  }

  public end(name: string) {
    if (this.runningTasks[name] === undefined) {
      throw new Error(`Task '${name}' was never started.`);
    }
    const info = this.runningTasks[name];
    info.refCount--;
    if (info.refCount === 0) {
      const usecs = now() - info.timestamp;
      verbose(`Task '${name}' completed after ${usecs} microseconds.`);
      this.emit(`end ${name}`);
    }
  }

}

export class Frontend {

  //public resolver = new SymbolResolver();
  //public evaluator = new Evaluator(this.resolver);
  public diagnostics: DiagnosticPrinter;
  public timing: Timing;

  private packagePathOverrides = new FastStringMap<string, string>();

  constructor() {
    this.diagnostics = new DiagnosticPrinter();
    this.timing = new Timing();
  }

  public mapPackageNameToPath(pkgName: string, pkgPath: string): void {
    this.packagePathOverrides.set(pkgName, pkgPath);
  }

  public check(program: Program) {

    const resolver = new SymbolResolver(program, new BoltSymbolResolutionStrategy);
    const checker = new TypeChecker(resolver);

    const container = new Container();
    container.bindSelf(program);
    container.bindSelf(resolver);
    container.bindSelf(checker);
    container.bindSelf(this.diagnostics);

    const checks: Newable<Visitor>[] = [
       CheckInvalidFilePaths,
       CheckReferences,
       CheckTypeAssignments,
    ];
    
    const checkers = checks.map(check => container.createInstance(check));

    for (const sourceFile of program.getAllSourceFiles()) {
      resolver.registerSourceFile(sourceFile);
    }
    for (const sourceFile of program.getAllSourceFiles()) {
      checker.registerSourceFile(sourceFile);
    }
    checker.solve(program.getAllSourceFiles());
    for (const pkg of program.getAllPackages()) {
      if (!pkg.isDependency) {
        for (const sourceFile of pkg.getAllSourceFiles()) {
          for (const node of sourceFile.preorder()) {
            for (const checker of checkers) {
              checker.visit(node);
            }
          }
        }
      }
    }
  }

  public compile(program: Program, target: string) {

    const container = new Container();
    const resolver = new SymbolResolver(program, new BoltSymbolResolutionStrategy);
    for (const sourceFile of program.getAllSourceFiles()) {
      resolver.registerSourceFile(sourceFile as BoltSourceFile);
    }
    const transforms = new TransformManager(container);
    container.bindSelf(transforms);
    container.bindSelf(program);
    container.bindSelf(resolver);

    switch (target) {

      case "JS":
        transforms.register(ExpandBoltTransform);
        transforms.register(CompileBoltToJSTransform);
        transforms.register(ConstFoldTransform);
        transforms.apply(program);
        break;

      default:
        throw new Error(`"${target}" is an invalid compile target.`);

    }

    for (const sourceFile of program.getAllSourceFiles()) {
      fs.mkdirp('.bolt-work');
      fs.writeFileSync(this.mapToTargetFile(sourceFile), emitNode(sourceFile), 'utf8');
    }

  }

  private mapToTargetFile(node: SourceFile) {
    return path.join('.bolt-work', getFileStem(node.span!.file.fullPath) + getDefaultFileExtension(getNodeLanguage(node)));
  }

  public eval(program: Program) {
    const resolver = new SymbolResolver(program, new BoltSymbolResolutionStrategy);
    const checker = new TypeChecker(resolver);
    const evaluator = new Evaluator(checker)
    for (const sourceFile of program.getAllSourceFiles()) {
      evaluator.eval(sourceFile)
    }
  }

  private parseSourceFile(filepath: string, pkg: Package): BoltSourceFile | null {

    const file = new TextFile(filepath);
    const contents = fs.readFileSync(file.origPath, 'utf8');
    const scanner = new Scanner(file, contents)
    const parser = new Parser();

    let sourceFile;
    try {
      sourceFile = parser.parseSourceFile(scanner, pkg);
    } catch (e) {
      if (e instanceof ScanError) {
        this.diagnostics.add({
          severity: 'fatal',
          message: E_SCAN_ERROR,
          args: { char: e.char },
          position: e.position,
          file: e.file,
        });
        return null;
      } else if (e instanceof ParseError) {
        this.diagnostics.add({
          message: E_PARSE_ERROR,
          args: { actual: describeKind(e.actual.kind), expected: e.expected.map(describeKind) },
          node: e.actual,
          severity: 'fatal',
        });
        return null;
      } else {
        throw e;
      }
    }

    setParents(sourceFile);

    return sourceFile;
  }

  public loadPackageFromPath(filepath: string, isDependency: boolean): Package {
    let metadataPath;
    let rootDir;
    if (path.basename(filepath) === 'Boltfile') {
      metadataPath = filepath
      rootDir = path.dirname(filepath);
    } else {
      metadataPath = path.join(filepath, 'Boltfile');
      rootDir = filepath;
    }
    const data = loadPackageMetadata(this.diagnostics, metadataPath);
    const pkg = new Package(rootDir, data.name, data.version, [], data.autoImport, isDependency);
    for (const filepath of globSync(path.join(rootDir, '**/*.bolt'))) {
      const sourceFile = this.parseSourceFile(filepath, pkg);
      if (sourceFile !== null) {
        pkg.addSourceFile(sourceFile);
      }
    }
    return pkg;
  }

  private findPackagePath(pkgName: string): string | null {
    if (this.packagePathOverrides.has(pkgName)) {
      return this.packagePathOverrides.get(pkgName);
    }
    return null;
  }

  public loadProgramFromFileList(filenames: string[], cwd = '.', useStd = true): Program | null {

    cwd = path.resolve(cwd);

    if (filenames.length === 0) {
      const metadataPath = upsearchSync('Boltfile');
      if (metadataPath === null) {
        this.diagnostics.add({
          severity: 'fatal',
          message: E_NO_BOLTFILE_FOUND_IN_PATH_OR_PARENT_DIRS,
        });
        return null;
      }
      filenames.push(metadataPath);
    }

    const anonPkg = new Package(cwd, null, null, [], false, false);
    
    const pkgs = [ anonPkg ];
    
    for (const filename of filenames) {

      if (fs.statSync(filename).isDirectory() || path.basename(filename) === 'Boltfile') {
        pkgs.push(this.loadPackageFromPath(filename, false));
      } else {
        const sourceFile = this.parseSourceFile(filename, anonPkg);
        if (sourceFile !== null) {
          anonPkg.addSourceFile(sourceFile);
        }
      }
    }

    if (useStd) {
      if (pkgs.find(pkg => pkg.name === 'stdlib') === undefined) {
        const resolvedPath = this.findPackagePath('stdlib');
        if (resolvedPath === null) {
          this.diagnostics.add({
            message: E_STDLIB_NOT_FOUND,
            severity: 'error',
          });
          return null;
        }
        const stdlibPkg = this.loadPackageFromPath(resolvedPath, true);
        pkgs.push(stdlibPkg);
      }

    }
    return new Program(pkgs);
  }

}

function getDefaultFileExtension(target: string) {
  if (targetExtensions[target] === undefined) {
    throw new Error(`Could not derive an appropriate extension for target "${target}".`)
  }
  return targetExtensions[target];
}

