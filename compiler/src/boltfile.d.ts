/* tslint:disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run json-schema-to-typescript to regenerate this file.
 */

/**
 * The specification file for a Bolt project
 */
export type Boltfile = PackageSpec[] | PackageSpec;

export interface PackageSpec {
  name: string;
  version: string;
  files?: (string | SourceSpec)[];
  [k: string]: unknown;
}
export interface SourceSpec {
  "auto-import"?: boolean;
  path: string;
}
