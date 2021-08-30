import { TypeScriptVersion } from "@definitelytyped/typescript-versions";
import { typeScriptPath } from "@definitelytyped/utils";
import assert = require("assert");
import { pathExists } from "fs-extra";
import { join as joinPaths, normalize } from "path";
import { Configuration, ILinterOptions, Linter } from "tslint";
type Configuration = typeof Configuration;
type IConfigurationFile = Configuration.IConfigurationFile;

import { Options as ExpectOptions } from "./rules/expectRule";

import { withoutPrefix } from "./util";

export async function lint(
    dirPath: string,
    minVersion: TsVersion,
    maxVersion: TsVersion,
    isLatest: boolean,
    expectOnly: boolean,
    tsLocal: string | undefined): Promise<string | undefined> {
    const tsconfigPath = joinPaths(dirPath, "tsconfig.json");
    const lintProgram = Linter.createProgram(tsconfigPath);

    const lintOptions: ILinterOptions = {
        fix: false,
        formatter: "stylish",
    };
    const linter = new Linter(lintOptions, lintProgram);
    const configPath = expectOnly ? joinPaths(__dirname, "..", "dtslint-expect-only.json") : getConfigPath(dirPath);
    const config = await getLintConfig(configPath, tsconfigPath, minVersion, maxVersion, tsLocal);

    for (const file of lintProgram.getSourceFiles()) {
        if (lintProgram.isSourceFileDefaultLibrary(file)) { continue; }

        const { fileName, text } = file;
        if (!fileName.includes("node_modules")) {
            const err = testNoTsIgnore(text) || testNoTslintDisables(text);
            if (err) {
                const { pos, message } = err;
                const place = file.getLineAndCharacterOfPosition(pos);
                return `At ${fileName}:${JSON.stringify(place)}: ${message}`;
            }
        }

        // typesVersions should be handled in a separate lint
        if (!isLatest || !isTypesVersionPath(fileName, dirPath)) {
            linter.lint(fileName, text, config);
        }
    }

    const result = linter.getResult();
    return result.failures.length ? result.output : undefined;
}


function normalizePath(file: string) {
    // replaces '\' with '/' and forces all DOS drive letters to be upper-case
    return normalize(file)
        .replace(/\\/g, "/")
        .replace(/^[a-z](?=:)/, c => c.toUpperCase());
}

function isTypesVersionPath(fileName: string, dirPath: string) {
    const normalFileName = normalizePath(fileName);
    const normalDirPath = normalizePath(dirPath);
    const subdirPath = withoutPrefix(normalFileName, normalDirPath);
    return subdirPath && /^\/ts\d+\.\d/.test(subdirPath);
}


interface Err { pos: number; message: string; }
function testNoTsIgnore(text: string): Err | undefined {
    const tsIgnore = "ts-ignore";
    const pos = text.indexOf(tsIgnore);
    return pos === -1 ? undefined : { pos, message: "'ts-ignore' is forbidden." };
}
function testNoTslintDisables(text: string): Err | undefined {
    const tslintDisable = "tslint:disable";
    let lastIndex = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const pos = text.indexOf(tslintDisable, lastIndex);
        if (pos === -1) {
            return undefined;
        }
        const end = pos + tslintDisable.length;
        const nextChar = text.charAt(end);
        if (nextChar !== "-" && nextChar !== ":") {
            const message = "'tslint:disable' is forbidden. " +
                "('tslint:disable:rulename', tslint:disable-line' and 'tslint:disable-next-line' are allowed.)";
            return { pos, message };
        }
        lastIndex = end;
    }
}

function getConfigPath(dirPath: string): string {
    return joinPaths(dirPath, "tslint.json");
}

async function getLintConfig(
    expectedConfigPath: string,
    tsconfigPath: string,
    minVersion: TsVersion,
    maxVersion: TsVersion,
    tsLocal: string | undefined,
): Promise<IConfigurationFile> {
    const configExists = await pathExists(expectedConfigPath);
    const configPath = configExists ? expectedConfigPath : joinPaths(__dirname, "..", "dtslint.json");
    // Second param to `findConfiguration` doesn't matter, since config path is provided.
    const config = Configuration.findConfiguration(configPath, "").results;
    if (!config) {
        throw new Error(`Could not load config at ${configPath}`);
    }

    const expectRule = config.rules.get("expect");
    if (!expectRule || expectRule.ruleSeverity !== "error") {
        throw new Error("'expect' rule should be enabled, else compile errors are ignored");
    }
    if (expectRule) {
        const versionsToTest =
            range(minVersion, maxVersion).map(versionName => ({ versionName, path: typeScriptPath(versionName, tsLocal) }));
        const expectOptions: ExpectOptions = { tsconfigPath, versionsToTest };
        expectRule.ruleArguments = [expectOptions];
    }
    return config;
}

function range(minVersion: TsVersion, maxVersion: TsVersion): ReadonlyArray<TsVersion> {
    if (minVersion === "local") {
        assert(maxVersion === "local");
        return ["local"];
    }
    if (minVersion === TypeScriptVersion.latest) {
        assert(maxVersion === TypeScriptVersion.latest);
        return [TypeScriptVersion.latest];
    }
    assert(maxVersion !== "local");

    const minIdx = TypeScriptVersion.shipped.indexOf(minVersion);
    assert(minIdx >= 0);
    if (maxVersion === TypeScriptVersion.latest) {
        return [...TypeScriptVersion.shipped.slice(minIdx), TypeScriptVersion.latest];
    }
    const maxIdx = TypeScriptVersion.shipped.indexOf(maxVersion as TypeScriptVersion);
    assert(maxIdx >= minIdx);
    return TypeScriptVersion.shipped.slice(minIdx, maxIdx + 1);
}

export type TsVersion = TypeScriptVersion | "local";
