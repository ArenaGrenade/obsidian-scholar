import { App, Notice, TFile, requestUrl } from "obsidian";
import { ObsidianScholarPluginSettings } from "./settingsTab";
import { FILE_ALREADY_EXISTS, NOTE_TEMPLATE_DEFAULT } from "./constants";
import { getDate } from "./utility";
import { StructuredPaperData } from "./paperData";

export class ObsidianScholar {
	settings: ObsidianScholarPluginSettings;
	app: App;
	pathSep: string;

	constructor(
		app: App,
		settings: ObsidianScholarPluginSettings,
		pathSep: string
	) {
		this.app = app;
		this.settings = settings;
		this.pathSep = pathSep;
	}

	constructFileName(paperData: StructuredPaperData): string {
		// TODO: Allow configuring this
		return paperData.title.replace(/[^a-zA-Z0-9 ]/g, "");
	}

	getPaperDataFromLocalFile(file: TFile): StructuredPaperData {
		let fileCache = this.app.metadataCache.getFileCache(file);
		let frontmatter = fileCache?.frontmatter;

		// We need to convert the link format to a regular pdf path
		let pdfPath = frontmatter?.pdf ?? "";
		pdfPath = pdfPath.match(/\[\[(.*?)\]\]/)[1];

		return {
			title: frontmatter?.title ?? file.basename,
			authors: frontmatter?.authors.split(",") ?? [],
			abstract: frontmatter?.abstract ?? "",
			url: frontmatter?.url ?? "",
			venue: frontmatter?.venue ?? "",
			publicationDate: frontmatter?.year ?? "",
			tags: frontmatter?.tags ?? [],
			pdfPath: pdfPath,
			citekey: frontmatter?.citekey ?? "",
		};
	}

	async getAllLocalPaperData(): Promise<StructuredPaperData[]> {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(this.settings.NoteLocation))
			.map((file) => {
				return this.getPaperDataFromLocalFile(file);
			});
	}

	// prettier-ignore
	async createFileWithTemplate(
		paperData: StructuredPaperData,
	) {
		let template = "";
		let templateFile = this.app.vault.getAbstractFileByPath(this.settings.templateFileLocation);
		if (templateFile != null && templateFile instanceof TFile) {
			template = await this.app.vault.cachedRead(templateFile as TFile);
		} else {
			template = NOTE_TEMPLATE_DEFAULT;
		}

		/* eslint-disable */
		// Replace for time information
		template = template.replace(/{{date}}/g, getDate({ format: "YYYY-MM-DD" }));
		template = template.replace(/{{time}}/g, getDate({ format: "HH:mm" }));
		template = template.replace(/{{date:(.*?)}}/g, (_, format) => getDate({ format }));
		template = template.replace(/{{time:(.*?)}}/g, (_, format) => getDate({ format }));

		// Replace for paper metadata
		template = template.replace(/{{title}}/g, paperData.title.replace("\n", " "));
		template = template.replace(/{{authors}}/g, paperData.authors.join(", ").replace("\n", " "));
		template = template.replace(/{{abstract}}/g, paperData.abstract.replace("\n", " "));
		template = template.replace(/{{url}}/g, paperData.url ? paperData.url.replace("\n", " ") : "");
		template = template.replace(/{{venue}}/g, paperData.venue ? paperData.venue.replace("\n", " ") : "");
		template = template.replace(/{{publicationDate}}/g, paperData.publicationDate ? paperData.publicationDate.replace("\n", " ") : "");
		template = template.replace(/{{tags}}/g, (paperData?.tags && paperData.tags.join(", ")) ?? "");

		// Replace for pdf file
		template = template.replace(/{{pdf}}/g, paperData.pdfPath ? `[[${paperData.pdfPath}]]` : "");
		if (paperData.citekey) {
			// we perhaps should keep the citekey in the template when the the bibtex is not available
			template = template.replace(/{{citekey}}/g, paperData.citekey);
		}
		/* eslint-enable */
		return template;
	}

	async createFileFromPaperData(
		paperData: StructuredPaperData,
		pathToFile: string
	) {
		let template = await this.createFileWithTemplate(paperData);

		//notification if the file already exists
		if (await this.app.vault.adapter.exists(pathToFile)) {
			new Notice(FILE_ALREADY_EXISTS);
			this.app.workspace.openLinkText(pathToFile, pathToFile);
		} else {
			await this.app.vault.create(pathToFile, template).then(() => {
				this.app.workspace.openLinkText(pathToFile, pathToFile);
			});
		}
		if (this.settings.openPdfAfterDownload) {
			let leaf = this.app.workspace.getLeaf("split", "vertical");
			paperData.pdfPath &&
				leaf.openFile(
					this.app.vault.getAbstractFileByPath(
						paperData.pdfPath
					) as TFile
				);
		}
	}

	async downloadPdf(
		pdfUrl: string | undefined | null,
		filename: string
	): Promise<string> {
		return new Promise(async (resolve, reject) => {
			// Check if pdfUrl is undefined or null
			if (!pdfUrl) {
				reject("pdfUrl is undefined or null");
				return;
			}

			let pdfDownloadFolder = this.settings.pdfDownloadLocation;
			let pdfSavePath =
				pdfDownloadFolder + this.pathSep + filename + ".pdf";

			// Check if the pdf already exists
			if (await this.app.vault.adapter.exists(pdfSavePath)) {
				resolve(pdfSavePath);
				return;
			}

			requestUrl({
				url: pdfUrl,
				method: "GET",
			})
				.arrayBuffer.then((arrayBuffer) => {
					this.app.vault
						.createBinary(pdfSavePath, arrayBuffer)
						.then(() => resolve(pdfSavePath))
						.catch(reject);
				})
				.catch(reject);
		});
	}

	async saveBibTex(bibtex: string) {
		if (this.settings.saveBibTex === false) {
			return;
		}

		let bibTexPath = this.settings.bibTexFileLocation;
		if (bibTexPath === "") {
			new Notice("BibTex location is not set in the settings.");
			return;
		}

		let bibtexText = "";
		if (await this.app.vault.adapter.exists(bibTexPath)) {
			let bibtexText = await this.app.vault.adapter.read(bibTexPath);
			if (bibtexText.includes(bibtex)) {
				new Notice("BibTex entry already exists.");
				return;
			}
		}

		let bibtextFile = this.app.vault.getAbstractFileByPath(bibTexPath);
		if (bibtextFile == null || !(bibtextFile instanceof TFile)) {
			new Notice("BibTex file not found.");
			return;
		}
		this.app.vault
			.append(bibtextFile as TFile, bibtex + "\n\n" + bibtexText)
			.then(() => {
				new Notice("BibTex entry saved.");
			})
			.catch((error) => {
				new Notice("Error: " + error);
			});
	}

	async downloadAndSavePaperNotePDF(paperData: StructuredPaperData) {
		let paperFilename = this.constructFileName(paperData);

		if (!paperData.pdfUrl) {
			new Notice("No pdf url found. You might need to find the PDF manually.");
		} else {
			// console.log("Downloading pdf...");
			paperData.pdfPath = await this.downloadPdf(
				paperData.pdfUrl,
				paperFilename
			);
		}

		let pathToFile =
			this.settings.NoteLocation + this.pathSep + paperFilename + ".md";

		// console.log("Creating note...");
		await this.createFileFromPaperData(paperData, pathToFile);

		// console.log("Saving bibtex...");
		paperData?.bibtex && (await this.saveBibTex(paperData.bibtex));
	}
}
