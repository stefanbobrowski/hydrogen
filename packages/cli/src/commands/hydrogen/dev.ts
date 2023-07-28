import path from 'path';
import fs from 'fs/promises';
import {outputDebug, outputInfo} from '@shopify/cli-kit/node/output';
import {fileExists, glob, readFile, writeFile} from '@shopify/cli-kit/node/fs';
import {renderFatalError} from '@shopify/cli-kit/node/ui';
import colors from '@shopify/cli-kit/node/colors';
import {copyPublicFiles} from './build.js';
import {
  getProjectPaths,
  getRemixConfig,
  type ServerMode,
} from '../../lib/config.js';
import {enhanceH2Logs, muteDevLogs, warnOnce} from '../../lib/log.js';
import {deprecated, commonFlags, flagsToCamelObject} from '../../lib/flags.js';
import Command from '@shopify/cli-kit/node/base-command';
import {Flags} from '@oclif/core';
import {type MiniOxygen, startMiniOxygen} from '../../lib/mini-oxygen.js';
import {checkHydrogenVersion} from '../../lib/check-version.js';
import {addVirtualRoutes} from '../../lib/virtual-routes.js';
import {spawnCodegenProcess} from '../../lib/codegen.js';
import {getAllEnvironmentVariables} from '../../lib/environment-variables.js';
import {getConfig} from '../../lib/shopify-config.js';
import {
  createMetaobjectDefinition,
  getMetaobjectDefinitions,
  updateMetaobjectDefinition,
} from '../../lib/graphql/admin/metaobject-definitions.js';
import type {MetaobjectDefinition} from '../../lib/graphql/admin/types-admin-api.js';
import {SectionSchema} from '../../lib/graphql/admin/types.js';
import {upsertMetaobject} from '../../lib/graphql/admin/metaobjects.js';

const LOG_REBUILDING = '🧱 Rebuilding...';
const LOG_REBUILT = '🚀 Rebuilt';

export default class Dev extends Command {
  static description =
    'Runs Hydrogen storefront in an Oxygen worker for development.';
  static flags = {
    path: commonFlags.path,
    port: commonFlags.port,
    ['codegen-unstable']: Flags.boolean({
      description:
        'Generate types for the Storefront API queries found in your project. It updates the types on file save.',
      required: false,
      default: false,
    }),
    ['codegen-config-path']: commonFlags.codegenConfigPath,
    sourcemap: commonFlags.sourcemap,
    'disable-virtual-routes': Flags.boolean({
      description:
        "Disable rendering fallback routes when a route file doesn't exist.",
      env: 'SHOPIFY_HYDROGEN_FLAG_DISABLE_VIRTUAL_ROUTES',
      default: false,
    }),
    debug: Flags.boolean({
      description: 'Attaches a Node inspector',
      env: 'SHOPIFY_HYDROGEN_FLAG_DEBUG',
      default: false,
    }),
    host: deprecated('--host')(),
    ['env-branch']: commonFlags.envBranch,
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(Dev);
    const directory = flags.path ? path.resolve(flags.path) : process.cwd();

    await runDev({
      ...flagsToCamelObject(flags),
      useCodegen: flags['codegen-unstable'],
      path: directory,
    });
  }
}

async function runDev({
  port,
  path: appPath,
  useCodegen = false,
  codegenConfigPath,
  disableVirtualRoutes,
  envBranch,
  debug = false,
  sourcemap = true,
}: {
  port?: number;
  path?: string;
  useCodegen?: boolean;
  codegenConfigPath?: string;
  disableVirtualRoutes?: boolean;
  envBranch?: string;
  debug?: boolean;
  sourcemap?: boolean;
}) {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

  muteDevLogs();

  if (debug) (await import('node:inspector')).open();

  const {root, publicPath, buildPathClient, buildPathWorkerFile} =
    getProjectPaths(appPath);

  const checkingHydrogenVersion = checkHydrogenVersion(root);

  const copyingFiles = copyPublicFiles(publicPath, buildPathClient);
  const reloadConfig = async () => {
    const config = await getRemixConfig(root);
    return disableVirtualRoutes
      ? config
      : addVirtualRoutes(config).catch((error) => {
          // Seen this fail when somehow NPM doesn't publish
          // the full 'virtual-routes' directory.
          // E.g. https://unpkg.com/browse/@shopify/cli-hydrogen@0.0.0-next-aa15969-20230703072007/dist/virtual-routes/
          outputDebug(
            'Could not add virtual routes: ' +
              (error?.stack ?? error?.message ?? error),
          );

          return config;
        });
  };

  const getFilePaths = (file: string) => {
    const fileRelative = path.relative(root, file);
    return [fileRelative, path.resolve(root, fileRelative)] as const;
  };

  const serverBundleExists = () => fileExists(buildPathWorkerFile);

  const {shop, storefront} = await getConfig(root);
  const isLoggedIn = !!shop && !!storefront?.id;
  const envPromise = getAllEnvironmentVariables({
    root,
    fetchRemote: isLoggedIn,
    envBranch,
  });

  const [{watch}, {createFileWatchCache}] = await Promise.all([
    import('@remix-run/dev/dist/compiler/watch.js'),
    import('@remix-run/dev/dist/compiler/fileWatchCache.js'),
  ]);

  let isInitialBuild = true;
  let initialBuildDurationMs = 0;
  let initialBuildStartTimeMs = Date.now();

  let miniOxygen: MiniOxygen;
  async function safeStartMiniOxygen() {
    if (miniOxygen) return;

    miniOxygen = await startMiniOxygen({
      root,
      port,
      watch: true,
      buildPathWorkerFile,
      buildPathClient,
      env: await envPromise,
    });

    const graphiqlUrl = `${miniOxygen.listeningAt}/graphiql`;
    enhanceH2Logs({graphiqlUrl, ...remixConfig});

    miniOxygen.showBanner({
      appName: storefront ? colors.cyan(storefront?.title) : undefined,
      headlinePrefix:
        initialBuildDurationMs > 0
          ? `Initial build: ${initialBuildDurationMs}ms\n`
          : '',
      extraLines: [colors.dim(`\nView GraphiQL API browser: ${graphiqlUrl}`)],
    });

    if (useCodegen) {
      spawnCodegenProcess({...remixConfig, configFilePath: codegenConfigPath});
    }

    const showUpgrade = await checkingHydrogenVersion;
    if (showUpgrade) showUpgrade();
  }

  const remixConfig = await reloadConfig();

  const fileWatchCache = createFileWatchCache();
  let skipRebuildLogs = false;

  const metaobjectDefinitions = await getMDForSections();
  // console.log({metaobjectDefinitions});

  // Compute initial schemas before build
  await Promise.all(
    (
      await glob('**/*.schema.{js,ts}', {
        cwd: remixConfig.appDirectory,
      })
    ).map((relativeFilepath) =>
      handleSchemaChange(
        path.resolve(remixConfig.appDirectory, relativeFilepath),
        metaobjectDefinitions,
      ),
    ),
  );

  await watch(
    {
      config: remixConfig,
      options: {
        mode: process.env.NODE_ENV as ServerMode,
        onWarning: warnOnce,
        sourcemap,
      },
      fileWatchCache,
    },
    {
      reloadConfig,
      onBuildStart() {
        if (!isInitialBuild && !skipRebuildLogs) {
          outputInfo(LOG_REBUILDING);
          console.time(LOG_REBUILT);
        }
      },
      async onBuildFinish() {
        if (isInitialBuild) {
          await copyingFiles;
          initialBuildDurationMs = Date.now() - initialBuildStartTimeMs;
          isInitialBuild = false;
        } else if (!skipRebuildLogs) {
          skipRebuildLogs = false;
          console.timeEnd(LOG_REBUILT);
          if (!miniOxygen) console.log(''); // New line
        }

        if (!miniOxygen) {
          if (!(await serverBundleExists())) {
            return renderFatalError({
              name: 'BuildError',
              type: 0,
              message:
                'MiniOxygen cannot start because the server bundle has not been generated.',
              tryMessage:
                'This is likely due to an error in your app and Remix is unable to compile. Try fixing the app and MiniOxygen will start.',
            });
          }

          await safeStartMiniOxygen();
        }
      },
      async onFileCreated(file: string) {
        const [relative, absolute] = getFilePaths(file);
        outputInfo(`\n📄 File created: ${relative}`);

        if (absolute.startsWith(publicPath)) {
          await copyPublicFiles(
            absolute,
            absolute.replace(publicPath, buildPathClient),
          );
        } else if (/\.schema\.[jt]s$/.test(file)) {
          await handleSchemaChange(file, metaobjectDefinitions);
        }
      },
      async onFileChanged(file: string) {
        fileWatchCache.invalidateFile(file);

        const [relative, absolute] = getFilePaths(file);
        outputInfo(`\n📄 File changed: ${relative}`);

        if (relative.endsWith('.env')) {
          skipRebuildLogs = true;
          await miniOxygen.reload({
            env: await getAllEnvironmentVariables({
              root,
              fetchRemote: isLoggedIn,
              envBranch,
            }),
          });
        } else if (/\.schema\.[jt]s$/.test(file)) {
          await handleSchemaChange(file, metaobjectDefinitions);
        }

        if (absolute.startsWith(publicPath)) {
          await copyPublicFiles(
            absolute,
            absolute.replace(publicPath, buildPathClient),
          );
        }
      },
      async onFileDeleted(file: string) {
        fileWatchCache.invalidateFile(file);

        const [relative, absolute] = getFilePaths(file);
        outputInfo(`\n📄 File deleted: ${relative}`);

        if (absolute.startsWith(publicPath)) {
          await fs.unlink(absolute.replace(publicPath, buildPathClient));
        }
      },
    },
  );
}

const HACK_SESSION = {
  storeFqdn: 'hydrogen-preview.myshopify.com',
  token: process.env.HACK_ACCESS_TOKEN as string,
};

async function handleSchemaChange(
  file: string,
  metaobjectDefinitions: Record<string, any>,
) {
  const {defineSection} = await import('@shopify/hydrogen');
  const originalFileContent = await readFile(file);
  const fileContentWithoutImports = originalFileContent
    .replace(/import\s+[^\s]+\s+from\s+['"][^'"]+['"];?/gims, '')
    .replace('defineSection', '')
    .trim();

  // TODO: URI import in Node doesn't seem to support `import` statements
  const mod = await import(
    'data:text/javascript;base64,' + btoa(fileContentWithoutImports)
  );

  // console.log('new', mod.default);
  // console.log('old', metaobjectDefinitions[mod.default.type]);

  if (hasMDChanged(mod.default, metaobjectDefinitions[mod.default.type])) {
    if (metaobjectDefinitions[mod.default.type]) {
      // Update MD
      metaobjectDefinitions[mod.default.type] =
        await updateMetaobjectDefinition(
          HACK_SESSION,
          mod.default,
          metaobjectDefinitions[mod.default.type],
        );
    } else {
      // Create MD
      metaobjectDefinitions[mod.default.type] =
        await createMetaobjectDefinition(HACK_SESSION, mod.default);
    }

    await upsertMetaobject(HACK_SESSION, mod.default);
  } else {
    console.log('NO CHANGE FOR', mod.default.type);
  }

  const result = defineSection(mod.default);
  const queryName =
    mod.default.name.replace(/\s/g, '_').toUpperCase() + '_QUERY';

  if (result.query !== mod[queryName]) {
    let content = originalFileContent;
    if (mod[queryName]) {
      // drop the old query
      content = (content.split(`export const ${queryName}`)[0] ?? '').trim();
    }

    await writeFile(
      file,
      content + `\nexport const ${queryName} = \`${result.query}\`;\n`,
    );
  }
}

async function getMDForSections() {
  return (await getMetaobjectDefinitions(HACK_SESSION))
    .filter((metaobject) => metaobject.type.startsWith('section_'))
    .reduce((acc, item) => {
      acc[item.type.replace('section_', '')] = item;
      return acc;
    }, {} as Record<string, any>);
}

function hasMDChanged(newMD: SectionSchema, existingMD: MetaobjectDefinition) {
  console.log({newMD, existingMD});
  if (newMD && !existingMD) return true;

  if (
    (['name', 'displayNameKey', 'description'] as const).some(
      (key) =>
        (newMD[key] || '') !==
        (existingMD[key] || '').replace('Section | ', ''),
    ) ||
    newMD.fields.length !== existingMD.fieldDefinitions.length
  ) {
    return true;
  }

  for (const existingField of existingMD.fieldDefinitions) {
    const newField = newMD.fields.find(
      (newField: any) => newField.key === existingField.key,
    );
    if (
      !newField ||
      (['name', 'description', 'required'] as const).some(
        (key) => newField[key] != existingField[key],
      )
    ) {
      return true;
    }
  }

  return false;
}
