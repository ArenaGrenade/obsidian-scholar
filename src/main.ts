import {
	App,
	TFile,
	TFolder,
	Editor,
	MarkdownView,
	SuggestModal,
	Modal,
	Notice,
	Plugin,
} from "obsidian";
import {
	StructuredPaperData,
	fetchArxivPaperDataFromUrl,
	fetchSemanticScholarPaperDataFromUrl,
	searchSemanticScholar,
} from "./paperData";
import {
	COMMAND_PAPER_NOTE_NAME,
	COMMAND_PAPER_NOTE_ID,
	COMMAND_SEARCH_PAPER,
	COMMAND_SEARCH_PAPER_NAME,
	COMMAND_PAPER_MODAL_TITLE,
	COMMAND_PAPER_MODAL_DESC,
	COMMAND_PAPER_MODAL_PLACEHOLDERS,
	NOTICE_RETRIEVING_ARXIV,
	NOTICE_RETRIEVING_S2,
	NOTE_TEMPLATE_DEFAULT,
	FILE_ALREADY_EXISTS,
	NOTICE_PAPER_NOTE_DOWNLOAD_ERROR,
} from "./constants";
import { getDate, trimString, isValidUrl } from "./utility";
import {
	ObsidianScholarSettingTab,
	ObsidianScholarPluginSettings,
	DEFAULT_SETTINGS,
} from "./settingsTab";
import { ObsidianScholar } from "./obsidianScholar";
import * as path from "path";

// Main Plugin Entry Point
export default class ObsidianScholarPlugin extends Plugin {
	settings: ObsidianScholarPluginSettings;
	obsidianScholar: ObsidianScholar;

	async onload() {
		// console.log("Loading ObsidianScholar Plugin.");
		await this.loadSettings();

		this.obsidianScholar = new ObsidianScholar(
			this.app,
			this.settings,
			path.sep
		);

		this.addCommand({
			id: COMMAND_PAPER_NOTE_ID,
			name: COMMAND_PAPER_NOTE_NAME,
			callback: () => {
				new createNoteFromUrlModal(
					this.app,
					this.settings,
					this.obsidianScholar
				).open();
			},
		});

		this.addCommand({
			id: COMMAND_SEARCH_PAPER,
			name: COMMAND_SEARCH_PAPER_NAME,
			callback: () => {
				new paperSearchModal(
					this.app,
					this.settings,
					this.obsidianScholar
				).open();
			},
		});

		this.addSettingTab(new ObsidianScholarSettingTab(this.app, this));

		// We want to be able to view bibtex files in obsidian
		this.registerExtensions(["bib"], "markdown");
		this.registerExtensions(["tex"], "markdown");
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

type KeyListener = (event: KeyboardEvent) => void;

interface PaperSearchModelResult {
	paper: StructuredPaperData;
	resultType: "local" | "semanticscholar";
	localFilePath?: string;
	s2Url?: string;
	isFirstS2Result?: boolean;
}
// The Paper Search Modal
class paperSearchModal extends SuggestModal<PaperSearchModelResult> {
	private settings: ObsidianScholarPluginSettings;
	obsidianScholar: ObsidianScholar;
	private keyListener: KeyListener;
	private lastSearchTime: number = 0;
	private delayInMs: number = 250;
	private lastSearch: string = "";
	private lastSearchResults: StructuredPaperData[] = [];
	private localPaperData: PaperSearchModelResult[] = [];

	constructor(
		app: App,
		settings: ObsidianScholarPluginSettings,
		obsidianScholar: ObsidianScholar
	) {
		super(app);
		this.settings = settings;
		this.obsidianScholar = obsidianScholar;

		// Adding the instructions
		const instructions = [
			["↑↓", "to navigate"],
			["↵", "to open"],
			["shift ↵", "to search semanticscholar"],
			["esc", "to dismiss"],
		];

		const modalInstructionsHTML = this.modalEl.createEl("div", {
			cls: "prompt-instructions",
		});
		for (const instruction of instructions) {
			const modalInstructionHTML = modalInstructionsHTML.createDiv({
				cls: "prompt-instruction",
			});
			modalInstructionHTML.createSpan({
				cls: "prompt-instruction-command",
				text: instruction[0],
			});
			modalInstructionHTML.createSpan({ text: instruction[1] });
		}

		this.setPlaceholder("Enter paper Name");

		this.localPaperData = this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(this.settings.NoteLocation))
			.map((file) => {
				return {
					paper: this.obsidianScholar.getPaperDataFromLocalFile(file),
					resultType: "local",
					localFilePath: file.path,
				};
			}); // We need to store the filepath as well
	}

	searchLocalPapers(query: string): PaperSearchModelResult[] {
		// console.log("Searching local papers");
		let results = this.localPaperData.filter((paper) => {
			return (
				paper.paper.title.toLowerCase().contains(query.toLowerCase()) ||
				paper.paper.authors
					.map((author) => author.toLowerCase())
					.some((author) => author.contains(query.toLowerCase()))
			);
		});
		return results;
	}

	async searchSemanticScholarWithDelay(query: string) {
		// Inspired by https://github.com/esm7/obsidian-map-view/blob/2b3be819067c2e2dd85418f61f8bd9a4f126ba7b/src/locationSearchDialog.ts#L149
		if (query === this.lastSearch || query.length < 3) return;
		const timestamp = Date.now();
		this.lastSearchTime = timestamp;
		const Sleep = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));
		await Sleep(this.delayInMs);
		if (this.lastSearchTime != timestamp) {
			// Search is canceled by a newer search
			return;
		}
		// After the sleep our search is still the last -- so the user stopped and we can go on
		this.lastSearch = query;
		this.lastSearchResults = await searchSemanticScholar(query);
		(this as any).updateSuggestions();
	}

	onOpen(): void {
		// Inspired by https://github.com/solderneer/obsidian-ai-tools/blob/313a9b9353001a88f731fde86beb80cc76412ebc/src/main.ts#L319
		this.keyListener = async (event: KeyboardEvent) => {
			if (event.repeat) return;

			if (event.shiftKey && event.key === "Enter") {
				// console.log("Searching on Semantic Scholar");

				const inputEl = document.querySelector(
					".prompt-input"
				) as HTMLInputElement;

				const query = inputEl.value;
				await this.searchSemanticScholarWithDelay(query);
			}

			if (event.key === "Tab") {
				// console.log("Tab pressed");
				const abstractHTML = document.querySelector(
					".suggestion-item.is-selected > .paper-search-result-abstract"
				);
				if (abstractHTML) {
					abstractHTML.classList.toggle("is-show");
				}
			}
		};
		document.addEventListener("keydown", this.keyListener);
	}

	getSuggestions(query: string): PaperSearchModelResult[] {
		let result: PaperSearchModelResult[] = [];

		let localResults = this.searchLocalPapers(query);
		result = result.concat(localResults);

		if (query == this.lastSearch) {
			result = result.concat(
				this.lastSearchResults.map((paper, index) => {
					return {
						paper: paper,
						resultType: "semanticscholar",
						s2Url: paper.url,
						isFirstS2Result: index === 0,
					};
				})
			);
		}
		// console.log(result);
		return result;
	}

	renderSuggestion(searchResult: PaperSearchModelResult, el: HTMLElement) {
		if (searchResult.resultType === "semanticscholar") {
			if (searchResult.isFirstS2Result) {
				el.createEl("div", {
					text: "SemanticScholar Search Results",
					cls: "paper-search-result-heading",
				});

				// const leadingPromptHTML = document.createEl("div", {
				// 	text: "SemanticScholar Search Results",
				// 	cls: "s2-result-heading",
				// });

				// this.resultContainerEl.appendChild(leadingPromptHTML);
			}
		}

		el.createEl("div", {
			text: searchResult.paper.title,
			cls: "paper-search-result-title",
		});
		el.createEl("div", {
			text: searchResult.paper.authors.join(", "),
			cls: "paper-search-result-authors",
		});
		el.createEl("div", {
			text: searchResult.paper.abstract,
			cls: "paper-search-result-abstract",
		});
	}

	onChooseSuggestion(
		searchResult: PaperSearchModelResult,
		evt: MouseEvent | KeyboardEvent
	) {
		if (searchResult.resultType === "local") {
			const localFilePath = searchResult.localFilePath;
			if (localFilePath) {
				this.app.workspace.openLinkText(localFilePath, localFilePath);
			} else {
				new Notice("Local file path not found");
			}
		} else {
			const s2Url = searchResult.s2Url;
			if (s2Url) {
				new Notice("Download Paper From S2");
				this.obsidianScholar.downloadAndSavePaperNotePDF(
					searchResult.paper
				);
			} else {
				new Notice("S2 URL not found");
			}
		}
	}

	onNoSuggestion() {
		this.resultContainerEl.empty();
	}
}

// The Paper Download Modal
class createNoteFromUrlModal extends Modal {
	settings: ObsidianScholarPluginSettings;
	obsidianScholar: ObsidianScholar;

	constructor(
		app: App,
		settings: ObsidianScholarPluginSettings,
		obsidianScholar: ObsidianScholar
	) {
		super(app);
		this.settings = settings;
		this.obsidianScholar = obsidianScholar;
	}

	addInputElementToModal(type: keyof HTMLElementTagNameMap): any {
		const { contentEl } = this;
		let input = contentEl.createEl(type);
		return input;
	}

	addPropertyToElement(
		element: HTMLElement,
		property: string,
		value: string
	): void {
		element.setAttribute(property, value);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h4", {
			text: COMMAND_PAPER_MODAL_TITLE,
			cls: "add-paper-title",
		});

		// randomly choose a placeholder
		let placeholder =
			COMMAND_PAPER_MODAL_PLACEHOLDERS[
				Math.floor(
					Math.random() * COMMAND_PAPER_MODAL_PLACEHOLDERS.length
				)
			];
		let input = this.addInputElementToModal("input");
		this.addPropertyToElement(input, "type", "search");
		this.addPropertyToElement(input, "placeholder", placeholder);
		this.addPropertyToElement(input, "minLength", "1");
		this.addPropertyToElement(input, "style", "width: 95%;");

		contentEl.createEl("p", {
			text: COMMAND_PAPER_MODAL_DESC,
			cls: "add-paper-description",
		});

		let running = false;
		contentEl.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;

			//get the URL from the input field
			let url = input.value.trim().toLowerCase();

			//check if the URL is valid
			if (!isValidUrl(url)) {
				new Notice("Invalid URL");
				return;
			}

			if (!running) {
				// Avoid multiple requests
				running = true;
				// console.log("HTTP request: " + url);
				this.fetchPaperDataAndCreateNoteFromUrl(url);
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async fetchPaperDataAndCreateNoteFromUrl(url: string) {
		let paperFetchFunction: Function;

		if (url.includes("arxiv.org")) {
			new Notice(NOTICE_RETRIEVING_ARXIV);
			paperFetchFunction = fetchArxivPaperDataFromUrl;
		} else {
			new Notice(NOTICE_RETRIEVING_S2);
			paperFetchFunction = fetchSemanticScholarPaperDataFromUrl;
		}
		paperFetchFunction(url)
			.then(async (paperData: StructuredPaperData) => {
				this.obsidianScholar.downloadAndSavePaperNotePDF(paperData);
			})
			.catch((error: any) => {
				new Notice(NOTICE_PAPER_NOTE_DOWNLOAD_ERROR);
				console.log(error);
			})
			.finally(() => {
				this.close();
			});
	}
}
