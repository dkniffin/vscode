/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNonEmptyArray } from 'vs/base/common/arrays';
import { disposableTimeout, timeout } from 'vs/base/common/async';
import { IStringDictionary } from 'vs/base/common/collections';
import { Event } from 'vs/base/common/event';
import { join } from 'vs/base/common/path';
import { isWindows } from 'vs/base/common/platform';
import { env } from 'vs/base/common/process';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { IExecutableBasedExtensionTip, IExtensionManagementService, ILocalExtension } from 'vs/platform/extensionManagement/common/extensionManagement';
import { areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { ExtensionTipsService as BaseExtensionTipsService } from 'vs/platform/extensionManagement/common/extensionTipsService';
import { IExtensionRecommendationNotificationService, RecommendationsNotificationResult, RecommendationSource } from 'vs/platform/extensionRecommendations/common/extensionRecommendations';
import { ExtensionType } from 'vs/platform/extensions/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { INativeHostService } from 'vs/platform/native/common/native';
import { IProductService } from 'vs/platform/product/common/productService';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

type ExeExtensionRecommendationsClassification = {
	owner: 'sandy081';
	comment: 'Information about executable based extension recommendation';
	extensionId: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'id of the recommended extension' };
	exeName: { classification: 'PublicNonPersonalData'; purpose: 'FeatureInsight'; comment: 'name of the executable for which extension is being recommended' };
};

type IExeBasedExtensionTips = {
	readonly exeFriendlyName: string;
	readonly windowsPath?: string;
	readonly recommendations: { extensionId: string; extensionName: string; isExtensionPack: boolean; whenNotInstalled?: string[] }[];
};

const promptedExecutableTipsStorageKey = 'extensionTips/promptedExecutableTips';
const lastPromptedMediumImpExeTimeStorageKey = 'extensionTips/lastPromptedMediumImpExeTime';

export class ExtensionTipsService extends BaseExtensionTipsService {

	private readonly highImportanceExecutableTips: Map<string, IExeBasedExtensionTips> = new Map<string, IExeBasedExtensionTips>();
	private readonly mediumImportanceExecutableTips: Map<string, IExeBasedExtensionTips> = new Map<string, IExeBasedExtensionTips>();
	private readonly allOtherExecutableTips: Map<string, IExeBasedExtensionTips> = new Map<string, IExeBasedExtensionTips>();

	private highImportanceTipsByExe = new Map<string, IExecutableBasedExtensionTip[]>();
	private mediumImportanceTipsByExe = new Map<string, IExecutableBasedExtensionTip[]>();

	constructor(
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IStorageService private readonly storageService: IStorageService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IExtensionRecommendationNotificationService private readonly extensionRecommendationNotificationService: IExtensionRecommendationNotificationService,
		@IFileService fileService: IFileService,
		@IProductService productService: IProductService,
	) {
		super(fileService, productService);
		if (productService.exeBasedExtensionTips) {
			Object.entries(productService.exeBasedExtensionTips).forEach(([key, exeBasedExtensionTip]) => {
				const highImportanceRecommendations: { extensionId: string; extensionName: string; isExtensionPack: boolean }[] = [];
				const mediumImportanceRecommendations: { extensionId: string; extensionName: string; isExtensionPack: boolean }[] = [];
				const otherRecommendations: { extensionId: string; extensionName: string; isExtensionPack: boolean }[] = [];
				Object.entries(exeBasedExtensionTip.recommendations).forEach(([extensionId, value]) => {
					if (value.important) {
						if (exeBasedExtensionTip.important) {
							highImportanceRecommendations.push({ extensionId, extensionName: value.name, isExtensionPack: !!value.isExtensionPack });
						} else {
							mediumImportanceRecommendations.push({ extensionId, extensionName: value.name, isExtensionPack: !!value.isExtensionPack });
						}
					} else {
						otherRecommendations.push({ extensionId, extensionName: value.name, isExtensionPack: !!value.isExtensionPack });
					}
				});
				if (highImportanceRecommendations.length) {
					this.highImportanceExecutableTips.set(key, { exeFriendlyName: exeBasedExtensionTip.friendlyName, windowsPath: exeBasedExtensionTip.windowsPath, recommendations: highImportanceRecommendations });
				}
				if (mediumImportanceRecommendations.length) {
					this.mediumImportanceExecutableTips.set(key, { exeFriendlyName: exeBasedExtensionTip.friendlyName, windowsPath: exeBasedExtensionTip.windowsPath, recommendations: mediumImportanceRecommendations });
				}
				if (otherRecommendations.length) {
					this.allOtherExecutableTips.set(key, { exeFriendlyName: exeBasedExtensionTip.friendlyName, windowsPath: exeBasedExtensionTip.windowsPath, recommendations: otherRecommendations });
				}
			});
		}

		/*
			3s has come out to be the good number to fetch and prompt important exe based recommendations
			Also fetch important exe based recommendations for reporting telemetry
		*/
		timeout(3000).then(async () => {
			await this.collectTips();
			this.promptHighImportanceExeBasedTip();
			this.promptMediumImportanceExeBasedTip();
		});
	}

	override async getImportantExecutableBasedTips(): Promise<IExecutableBasedExtensionTip[]> {
		const highImportanceExeTips = await this.getValidExecutableBasedExtensionTips(this.highImportanceExecutableTips);
		const mediumImportanceExeTips = await this.getValidExecutableBasedExtensionTips(this.mediumImportanceExecutableTips);
		return [...highImportanceExeTips, ...mediumImportanceExeTips];
	}

	override getOtherExecutableBasedTips(): Promise<IExecutableBasedExtensionTip[]> {
		return this.getValidExecutableBasedExtensionTips(this.allOtherExecutableTips);
	}

	private async collectTips(): Promise<void> {
		const highImportanceExeTips = await this.getValidExecutableBasedExtensionTips(this.highImportanceExecutableTips);
		const mediumImportanceExeTips = await this.getValidExecutableBasedExtensionTips(this.mediumImportanceExecutableTips);
		const local = await this.extensionManagementService.getInstalled();

		this.highImportanceTipsByExe = this.groupImportantTipsByExe(highImportanceExeTips, local);
		this.mediumImportanceTipsByExe = this.groupImportantTipsByExe(mediumImportanceExeTips, local);
	}

	private groupImportantTipsByExe(importantExeBasedTips: IExecutableBasedExtensionTip[], local: ILocalExtension[]): Map<string, IExecutableBasedExtensionTip[]> {
		const importantExeBasedRecommendations = new Map<string, IExecutableBasedExtensionTip>();
		importantExeBasedTips.forEach(tip => importantExeBasedRecommendations.set(tip.extensionId.toLowerCase(), tip));

		const { installed, uninstalled: recommendations } = this.groupByInstalled([...importantExeBasedRecommendations.keys()], local);

		/* Log installed and uninstalled exe based recommendations */
		for (const extensionId of installed) {
			const tip = importantExeBasedRecommendations.get(extensionId);
			if (tip) {
				this.telemetryService.publicLog2<{ exeName: string; extensionId: string }, ExeExtensionRecommendationsClassification>('exeExtensionRecommendations:alreadyInstalled', { extensionId, exeName: tip.exeName });
			}
		}
		for (const extensionId of recommendations) {
			const tip = importantExeBasedRecommendations.get(extensionId);
			if (tip) {
				this.telemetryService.publicLog2<{ exeName: string; extensionId: string }, ExeExtensionRecommendationsClassification>('exeExtensionRecommendations:notInstalled', { extensionId, exeName: tip.exeName });
			}
		}

		const promptedExecutableTips = this.getPromptedExecutableTips();
		const tipsByExe = new Map<string, IExecutableBasedExtensionTip[]>();
		for (const extensionId of recommendations) {
			const tip = importantExeBasedRecommendations.get(extensionId);
			if (tip && (!promptedExecutableTips[tip.exeName] || !promptedExecutableTips[tip.exeName].includes(tip.extensionId))) {
				let tips = tipsByExe.get(tip.exeName);
				if (!tips) {
					tips = [];
					tipsByExe.set(tip.exeName, tips);
				}
				tips.push(tip);
			}
		}

		return tipsByExe;
	}

	/**
	 * High importance tips are prompted once per restart session
	 */
	private promptHighImportanceExeBasedTip(): void {
		if (this.highImportanceTipsByExe.size === 0) {
			return;
		}

		const [exeName, tips] = [...this.highImportanceTipsByExe.entries()][0];
		this.promptExeRecommendations(tips)
			.then(result => {
				switch (result) {
					case RecommendationsNotificationResult.Accepted:
						this.addToRecommendedExecutables(tips[0].exeName, tips);
						break;
					case RecommendationsNotificationResult.Ignored:
						this.highImportanceTipsByExe.delete(exeName);
						break;
					case RecommendationsNotificationResult.IncompatibleWindow: {
						// Recommended in incompatible window. Schedule the prompt after active window change
						const onActiveWindowChange = Event.once(Event.latch(Event.any(this.nativeHostService.onDidOpenWindow, this.nativeHostService.onDidFocusWindow)));
						this._register(onActiveWindowChange(() => this.promptHighImportanceExeBasedTip()));
						break;
					}
					case RecommendationsNotificationResult.TooMany: {
						// Too many notifications. Schedule the prompt after one hour
						const disposable = this._register(disposableTimeout(() => { disposable.dispose(); this.promptHighImportanceExeBasedTip(); }, 60 * 60 * 1000 /* 1 hour */));
						break;
					}
				}
			});
	}

	/**
	 * Medium importance tips are prompted once per 7 days
	 */
	private promptMediumImportanceExeBasedTip(): void {
		if (this.mediumImportanceTipsByExe.size === 0) {
			return;
		}

		const lastPromptedMediumExeTime = this.getLastPromptedMediumExeTime();
		const timeSinceLastPrompt = Date.now() - lastPromptedMediumExeTime;
		const promptInterval = 7 * 24 * 60 * 60 * 1000; // 7 Days
		if (timeSinceLastPrompt < promptInterval) {
			// Wait until interval and prompt
			const disposable = this._register(disposableTimeout(() => { disposable.dispose(); this.promptMediumImportanceExeBasedTip(); }, promptInterval - timeSinceLastPrompt));
			return;
		}

		const [exeName, tips] = [...this.mediumImportanceTipsByExe.entries()][0];
		this.promptExeRecommendations(tips)
			.then(result => {
				switch (result) {
					case RecommendationsNotificationResult.Accepted: {
						// Accepted: Update the last prompted time and caches.
						this.updateLastPromptedMediumExeTime(Date.now());
						this.mediumImportanceTipsByExe.delete(exeName);
						this.addToRecommendedExecutables(tips[0].exeName, tips);

						// Schedule the next recommendation for next internval
						const disposable1 = this._register(disposableTimeout(() => { disposable1.dispose(); this.promptMediumImportanceExeBasedTip(); }, promptInterval));
						break;
					}
					case RecommendationsNotificationResult.Ignored:
						// Ignored: Remove from the cache and prompt next recommendation
						this.mediumImportanceTipsByExe.delete(exeName);
						this.promptMediumImportanceExeBasedTip();
						break;

					case RecommendationsNotificationResult.IncompatibleWindow: {
						// Recommended in incompatible window. Schedule the prompt after active window change
						const onActiveWindowChange = Event.once(Event.latch(Event.any(this.nativeHostService.onDidOpenWindow, this.nativeHostService.onDidFocusWindow)));
						this._register(onActiveWindowChange(() => this.promptMediumImportanceExeBasedTip()));
						break;
					}
					case RecommendationsNotificationResult.TooMany: {
						// Too many notifications. Schedule the prompt after one hour
						const disposable2 = this._register(disposableTimeout(() => { disposable2.dispose(); this.promptMediumImportanceExeBasedTip(); }, 60 * 60 * 1000 /* 1 hour */));
						break;
					}
				}
			});
	}

	private async promptExeRecommendations(tips: IExecutableBasedExtensionTip[]): Promise<RecommendationsNotificationResult> {
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User);
		const extensionIds = tips
			.filter(tip => !tip.whenNotInstalled || tip.whenNotInstalled.every(id => installed.every(local => !areSameExtensions(local.identifier, { id }))))
			.map(({ extensionId }) => extensionId.toLowerCase());
		const message = localize({ key: 'exeRecommended', comment: ['Placeholder string is the name of the software that is installed.'] }, "You have {0} installed on your system. Do you want to install the recommended extensions for it?", tips[0].exeFriendlyName);
		return this.extensionRecommendationNotificationService.promptImportantExtensionsInstallNotification(extensionIds, message, `@exe:"${tips[0].exeName}"`, RecommendationSource.EXE);
	}

	private getLastPromptedMediumExeTime(): number {
		let value = this.storageService.getNumber(lastPromptedMediumImpExeTimeStorageKey, StorageScope.APPLICATION);
		if (!value) {
			value = Date.now();
			this.updateLastPromptedMediumExeTime(value);
		}
		return value;
	}

	private updateLastPromptedMediumExeTime(value: number): void {
		this.storageService.store(lastPromptedMediumImpExeTimeStorageKey, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private getPromptedExecutableTips(): IStringDictionary<string[]> {
		return JSON.parse(this.storageService.get(promptedExecutableTipsStorageKey, StorageScope.APPLICATION, '{}'));
	}

	private addToRecommendedExecutables(exeName: string, tips: IExecutableBasedExtensionTip[]) {
		const promptedExecutableTips = this.getPromptedExecutableTips();
		promptedExecutableTips[exeName] = tips.map(({ extensionId }) => extensionId.toLowerCase());
		this.storageService.store(promptedExecutableTipsStorageKey, JSON.stringify(promptedExecutableTips), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private groupByInstalled(recommendationsToSuggest: string[], local: ILocalExtension[]): { installed: string[]; uninstalled: string[] } {
		const installed: string[] = [], uninstalled: string[] = [];
		const installedExtensionsIds = local.reduce((result, i) => { result.add(i.identifier.id.toLowerCase()); return result; }, new Set<string>());
		recommendationsToSuggest.forEach(id => {
			if (installedExtensionsIds.has(id.toLowerCase())) {
				installed.push(id);
			} else {
				uninstalled.push(id);
			}
		});
		return { installed, uninstalled };
	}

	private async getValidExecutableBasedExtensionTips(executableTips: Map<string, IExeBasedExtensionTips>): Promise<IExecutableBasedExtensionTip[]> {
		const result: IExecutableBasedExtensionTip[] = [];

		const checkedExecutables: Map<string, boolean> = new Map<string, boolean>();
		for (const exeName of executableTips.keys()) {
			const extensionTip = executableTips.get(exeName);
			if (!extensionTip || !isNonEmptyArray(extensionTip.recommendations)) {
				continue;
			}

			const exePaths: string[] = [];
			if (isWindows) {
				if (extensionTip.windowsPath) {
					exePaths.push(extensionTip.windowsPath.replace('%USERPROFILE%', () => env['USERPROFILE']!)
						.replace('%ProgramFiles(x86)%', () => env['ProgramFiles(x86)']!)
						.replace('%ProgramFiles%', () => env['ProgramFiles']!)
						.replace('%APPDATA%', () => env['APPDATA']!)
						.replace('%WINDIR%', () => env['WINDIR']!));
				}
			} else {
				exePaths.push(join('/usr/local/bin', exeName));
				exePaths.push(join('/usr/bin', exeName));
				exePaths.push(join(this.environmentService.userHome.fsPath, exeName));
			}

			for (const exePath of exePaths) {
				let exists = checkedExecutables.get(exePath);
				if (exists === undefined) {
					exists = await this.fileService.exists(URI.file(exePath));
					checkedExecutables.set(exePath, exists);
				}
				if (exists) {
					for (const { extensionId, extensionName, isExtensionPack, whenNotInstalled } of extensionTip.recommendations) {
						result.push({
							extensionId,
							extensionName,
							isExtensionPack,
							exeName,
							exeFriendlyName: extensionTip.exeFriendlyName,
							windowsPath: extensionTip.windowsPath,
							whenNotInstalled: whenNotInstalled
						});
					}
				}
			}
		}

		return result;
	}

}
