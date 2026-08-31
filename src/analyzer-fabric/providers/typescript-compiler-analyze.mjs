import path from 'node:path';
import { FabricProviderError } from './common.mjs';
import {
  normalizeRepoPath,
  isDeclarationName,
  symbolAt,
  firstRepositoryDeclaration,
  declarationIdentity,
  isDirectCallTarget,
  isTypeUse,
  isHeritageUse,
  makeRawObservation
} from './typescript-compiler-utils.mjs';

export async function analyzeTypeScriptProgram({ typescript, provider, input, context, expectedTypeScriptVersion, tsVersion }) {
      const rootInput = input?.rootDirectory ?? input?.root_directory;
      if (typeof rootInput !== 'string' || !rootInput.trim()) throw new FabricProviderError('PARSE_FAILED', 'TypeScript provider requires rootDirectory');
      const rootDirectory = path.resolve(rootInput);
      if (expectedTypeScriptVersion && tsVersion !== String(expectedTypeScriptVersion)) {
        throw new FabricProviderError('ANALYZER_TOOLCHAIN_MISMATCH', `TypeScript compiler version ${tsVersion} does not match expected ${expectedTypeScriptVersion}`);
      }
      const tsconfigPath = path.resolve(rootDirectory, String(input?.tsconfigPath ?? input?.tsconfig_path ?? 'tsconfig.json'));
      const config = typescript.readConfigFile(tsconfigPath, typescript.sys.readFile);
      if (config.error) throw new FabricProviderError('PARSE_FAILED', typescript.flattenDiagnosticMessageText(config.error.messageText, '\n'));
      const parsed = typescript.parseJsonConfigFileContent(config.config, typescript.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
      if (parsed.errors?.length) {
        throw new FabricProviderError('PARSE_FAILED', parsed.errors.map(item => typescript.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
      }
      const program = typescript.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences
      });
      const checker = program.getTypeChecker();
      const observations = [];
      const seen = new Set();
      const sourceFiles = program.getSourceFiles().filter(sourceFile => {
        const relative = normalizeRepoPath(rootDirectory, sourceFile.fileName);
        return Boolean(relative && /\.(?:ts|tsx|mts|cts)$/.test(relative) && !/\.d\.(?:ts|mts|cts)$/.test(relative));
      });

      const emit = (key, observation) => {
        if (seen.has(key)) return;
        seen.add(key);
        observations.push(observation);
      };

      for (const sourceFile of sourceFiles) {
        const sourceText = sourceFile.getFullText();
        const visit = node => {
          if (typescript.isIdentifier(node)) {
            const symbol = symbolAt(checker, typescript, node);
            const declarationInfo = firstRepositoryDeclaration(symbol, rootDirectory);
            if (symbol && declarationInfo) {
              const identity = declarationIdentity(typescript, symbol, declarationInfo, rootDirectory);
              const relative = normalizeRepoPath(rootDirectory, sourceFile.fileName);
              const syntaxKind = typescript.SyntaxKind[node.parent?.kind ?? node.kind] ?? String(node.parent?.kind ?? node.kind);
              const base = { sourceFile, sourceText, node, identity, syntaxKind, tsconfigPath: path.relative(rootDirectory, tsconfigPath).replaceAll('\\','/') };
              const locationKey = `${relative}\0${node.getStart(sourceFile,false)}\0${node.getEnd()}\0${identity.semantic_symbol_id}`;
              if (isDeclarationName(typescript, node)) {
                emit(`decl\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                  ...base, capability: 'DECLARATION', observationType: 'DECLARATION'
                }));
                emit(`symbol\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                  ...base, capability: 'SYMBOL', observationType: 'SYMBOL_DEFINITION'
                }));
              } else {
                emit(`ref\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                  ...base, capability: 'REFERENCE', observationType: 'SYMBOL_REFERENCE'
                }));
                if (identity.declaration_path !== relative) {
                  emit(`cross\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                    ...base,
                    capability: 'CROSS_FILE_REFERENCE',
                    observationType: 'CROSS_FILE_REFERENCE',
                    target: { target_symbol_id: identity.semantic_symbol_id, target_file: identity.declaration_path }
                  }));
                }
                if (isDirectCallTarget(typescript, node)) {
                  emit(`call\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                    ...base,
                    capability: 'CALL',
                    observationType: 'RESOLVED_CALL',
                    target: { target_symbol_id: identity.semantic_symbol_id, target_file: identity.declaration_path }
                  }));
                }
                if (isTypeUse(typescript, node)) {
                  emit(`type\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                    ...base,
                    capability: 'TYPE',
                    observationType: 'RESOLVED_TYPE_USE',
                    target: { target_symbol_id: identity.semantic_symbol_id, target_file: identity.declaration_path }
                  }));
                }
                if (isHeritageUse(typescript, node)) {
                  emit(`inheritance\0${locationKey}`, makeRawObservation(provider, { ...context, rootDirectory, typescriptVersion: tsVersion }, {
                    ...base,
                    capability: 'INHERITANCE',
                    observationType: 'RESOLVED_HERITAGE_USE',
                    target: { target_symbol_id: identity.semantic_symbol_id, target_file: identity.declaration_path }
                  }));
                }
              }
            }
          }
          typescript.forEachChild(node, visit);
        };
        visit(sourceFile);
      }
      return observations;
}
