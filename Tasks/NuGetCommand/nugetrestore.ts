import * as tl from "vsts-task-lib/task";
import * as path from "path";
import * as Q  from "q";
import {IExecOptions} from "vsts-task-lib/toolrunner";

import * as auth from "./Common/Authentication";
import { IPackageSource } from "./Common/Authentication";
import INuGetCommandOptions from "./Common/INuGetCommandOptions";
import locationHelpers = require("nuget-task-common/LocationHelpers");
import {NuGetConfigHelper} from "./Common/NuGetConfigHelper";
import nuGetGetter = require("nuget-task-common/NuGetToolGetter");
import * as ngToolRunner from "./Common/NuGetToolRunner";
import * as nutil from "nuget-task-common/Utility";
import * as vsts from "vso-node-api/WebApi";
import * as vsom from 'vso-node-api/VsoClient';
import peParser = require('nuget-task-common/pe-parser/index');
import {VersionInfo} from "nuget-task-common/pe-parser/VersionResource";
import * as utilities from "./Common/utilities";

const NUGET_ORG_V2_URL: string = "https://www.nuget.org/api/v2/";
const NUGET_ORG_V3_URL: string = "https://api.nuget.org/v3/index.json";

class RestoreOptions implements INuGetCommandOptions {
    constructor(
        public nuGetPath: string,
        public configFile: string,
        public noCache: boolean,
        public verbosity: string,
        public packagesDirectory: string,
        public environment: ngToolRunner.NuGetEnvironmentSettings,
        public authInfo: auth.NuGetAuthInfo
    ) { }
}

export async function run(nuGetPath: string): Promise<void> {
    let buildIdentityDisplayName: string = null;
    let buildIdentityAccount: string = null;

    try {
        

        nutil.setConsoleCodePage();

        // Reading inputs
        let solution = tl.getPathInput("solution", true, false);
        let useLegacyFind: boolean = tl.getVariable("NuGet.UseLegacyFindFiles") === "true";
        let filesList: string[] = [];
        if (!useLegacyFind) {
            let findOptions: tl.FindOptions = <tl.FindOptions>{};
            let matchOptions: tl.MatchOptions = <tl.MatchOptions>{};
            filesList = tl.findMatch(undefined, solution, findOptions, matchOptions);
        }
        else {
            filesList = nutil.resolveFilterSpec(solution, tl.getVariable("System.DefaultWorkingDirectory") || process.cwd());
        }
        filesList.forEach(solutionFile => {
            if (!tl.stats(solutionFile).isFile()) {
                throw new Error(tl.loc("NotARegularFile", solutionFile));
            }
        });
        let noCache = tl.getBoolInput("noCache");
        let verbosity = tl.getInput("verbosityRestore");
        let packagesDirectory = tl.getPathInput("packagesDirectory");
        if (!tl.filePathSupplied("packagesDirectory")) {
            packagesDirectory = null;
        }
        
        const nuGetVersion: VersionInfo = await peParser.getFileVersionInfoAsync(nuGetPath);

        // Discovering NuGet quirks based on the version
        tl.debug('Getting NuGet quirks');
        const quirks = await ngToolRunner.getNuGetQuirksAsync(nuGetPath);
        let credProviderPath = nutil.locateCredentialProvider();
        // Clauses ordered in this way to avoid short-circuit evaluation, so the debug info printed by the functions
        // is unconditionally displayed
        const useCredProvider = ngToolRunner.isCredentialProviderEnabled(quirks) && credProviderPath;
        const useCredConfig = ngToolRunner.isCredentialConfigEnabled(quirks) && !useCredProvider;
        
        // Setting up auth-related variables
        tl.debug('Setting up auth');
        let serviceUri = tl.getEndpointUrl("SYSTEMVSSCONNECTION", false);
        let urlPrefixes = await locationHelpers.assumeNuGetUriPrefixes(serviceUri);
        tl.debug(`Discovered URL prefixes: ${urlPrefixes}`);;
        // Note to readers: This variable will be going away once we have a fix for the location service for
        // customers behind proxies
        let testPrefixes = tl.getVariable("NuGetTasks.ExtraUrlPrefixesForTesting");
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(";"));
            tl.debug(`All URL prefixes: ${urlPrefixes}`);
        }
        let accessToken = auth.getSystemAccessToken();
        let externalAuthArr: auth.ExternalAuthInfo[] = utilities.GetExternalAuthInfoArray("externalEndpoints");
        const authInfo = new auth.NuGetAuthInfo(new auth.InternalAuthInfo(urlPrefixes, accessToken, useCredProvider, useCredConfig), externalAuthArr);
        let environmentSettings: ngToolRunner.NuGetEnvironmentSettings = {
            credProviderFolder: useCredProvider ? path.dirname(credProviderPath) : null,
            extensionsDisabled: true
        };

        // Setting up sources, either from provided config file or from feed selection
        tl.debug('Setting up sources');
        let nuGetConfigPath : string = undefined;
        let selectOrConfig = tl.getInput("selectOrConfig");
        // This IF is here in order to provide a value to nuGetConfigPath (if option selected, if user provided it)
        // and then pass it into the config helper
        if (selectOrConfig === "config" ) {
            nuGetConfigPath = tl.getPathInput("nugetConfigPath", false, true);
            if (!tl.filePathSupplied("nugetConfigPath")) {
                nuGetConfigPath = undefined;
            }
        }
        
        // If there was no nuGetConfigPath, NuGetConfigHelper will create one
        let nuGetConfigHelper = new NuGetConfigHelper(
                    nuGetPath,
                    nuGetConfigPath,
                    authInfo,
                    environmentSettings);
        
        let credCleanup = () => { return; };
        
        // Now that the NuGetConfigHelper was initialized with all the known information we can proceed
        // and check if the user picked the 'select' option to fill out the config file if needed
        if (selectOrConfig === "select" ) {
            let sources: Array<IPackageSource> = new Array<IPackageSource>();
            let feed = tl.getInput("feedRestore");
            if (feed) {
                let feedUrl:string = await utilities.getNuGetFeedRegistryUrl(accessToken, feed, nuGetVersion);
                sources.push(<IPackageSource>
                {
                    feedName: feed,
                    feedUri: feedUrl,
                    isInternal: true
                })
            }

            let includeNuGetOrg = tl.getBoolInput("includeNuGetOrg", false);
            if (includeNuGetOrg) {
                let nuGetUrl: string = nuGetVersion.productVersion.a < 3 ? NUGET_ORG_V2_URL : NUGET_ORG_V3_URL;
                sources.push(<IPackageSource>
                {
                    feedName: "NuGetOrg",
                    feedUri: nuGetUrl,
                    isInternal: false
                })
            }

            // Creating NuGet.config for the user
            if (sources.length > 0)
            {
                tl.debug(`Adding the following sources to the config file: ${sources.map(x => x.feedName).join(';')}`)
                nuGetConfigHelper.addSourcesToTempNuGetConfig(sources);
                credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath);
                nuGetConfigPath = nuGetConfigHelper.tempNugetConfigPath;
            }
            else {
                tl.debug('No sources were added to the temp NuGet.config file');
            }
        }

        // Setting creds in the temp NuGet.config if needed
        await nuGetConfigHelper.setAuthForSourcesInTempNuGetConfigAsync();

        let configFile = nuGetConfigHelper.tempNugetConfigPath;

        try {
            let restoreOptions = new RestoreOptions(
                nuGetPath,
                configFile,
                noCache,
                verbosity,
                packagesDirectory,
                environmentSettings,
                authInfo);

            for (const solutionFile of filesList) {
                await restorePackagesAsync(solutionFile, restoreOptions);
            }
        } finally {
            credCleanup();
        }

        tl.setResult(tl.TaskResult.Succeeded, tl.loc("PackagesInstalledSuccessfully"));
    } catch (err) {
        tl.error(err);

        if (buildIdentityDisplayName || buildIdentityAccount) {
            tl.warning(tl.loc("BuildIdentityPermissionsHint", buildIdentityDisplayName, buildIdentityAccount));
        }

        tl.setResult(tl.TaskResult.Failed, tl.loc("PackagesFailedToInstall"));
    }
}

function restorePackagesAsync(solutionFile: string, options: RestoreOptions): Q.Promise<number> {
    let nugetTool = ngToolRunner.createNuGetToolRunner(options.nuGetPath, options.environment, options.authInfo);

    nugetTool.arg("restore");
    nugetTool.arg(solutionFile);

    if (options.packagesDirectory) {
        nugetTool.arg("-PackagesDirectory");
        nugetTool.arg(options.packagesDirectory);
    }

    if (options.noCache) {
        nugetTool.arg("-NoCache");
    }

    if (options.verbosity && options.verbosity !== "-") {
        nugetTool.arg("-Verbosity");
        nugetTool.arg(options.verbosity);
    }

    nugetTool.arg("-NonInteractive");

    if (options.configFile) {
        nugetTool.arg("-ConfigFile");
        nugetTool.arg(options.configFile);
    }
    
    return nugetTool.exec({ cwd: path.dirname(solutionFile) } as IExecOptions);
}