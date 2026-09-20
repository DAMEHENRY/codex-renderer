import AppKit
import Darwin
import Foundation
import PDFKit
import UniformTypeIdentifiers

private enum CaptureFailure: Error, LocalizedError {
    case missingOutputDirectory
    case missingResultFile
    case missingArgumentValue(String)
    case unknownArgument(String)
    case pathMustBeAbsolute(String)
    case noSupportedPasteboardContent
    case cannotDecodeImage
    case cannotDecodePDF
    case cannotRenderPDFPage(Int)

    var errorDescription: String? {
        switch self {
        case .missingOutputDirectory:
            return "Missing required --output-dir argument."
        case .missingResultFile:
            return "Missing required --result-file argument."
        case .missingArgumentValue(let flag):
            return "Missing value after \(flag)."
        case .unknownArgument(let flag):
            return "Unknown argument: \(flag)."
        case .pathMustBeAbsolute(let flag):
            return "The \(flag) path must be absolute."
        case .noSupportedPasteboardContent:
            return "The iPhone import pasteboard did not contain an image or PDF."
        case .cannotDecodeImage:
            return "The imported image could not be decoded."
        case .cannotDecodePDF:
            return "The imported PDF could not be opened."
        case .cannotRenderPDFPage(let page):
            return "Could not render PDF page \(page)."
        }
    }
}

private struct HelperArguments {
    let outputDirectory: URL
    let resultFile: URL
    let cancelFile: URL?
}

private enum PasteboardPayload {
    case imageData(Data)
    case image(NSImage)
    case pdfData(Data)
    case file(URL)
}

@MainActor
private final class CaptureTextView: NSTextView {
    var onCapture: (([URL]) -> Void)?
    var onFailure: ((Error) -> Void)?
    var onCancel: (() -> Void)?

    override func validRequestor(
        forSendType sendType: NSPasteboard.PasteboardType?,
        returnType: NSPasteboard.PasteboardType?
    ) -> Any? {
        if let rawType = returnType?.rawValue,
           let type = UTType(rawType),
           (type.conforms(to: .image) || type.conforms(to: .pdf)) {
            return self
        }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    override func readSelection(from pasteboard: NSPasteboard) -> Bool {
        do {
            let savedURLs = try PasteboardImporter.saveImages(
                from: pasteboard,
                to: PasteboardImporter.outputDirectory
            )
            onCapture?(savedURLs)
            return true
        } catch {
            onFailure?(error)
            return false
        }
    }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            onCancel?()
            return
        }
        super.keyDown(with: event)
    }
}

@MainActor
private enum PasteboardImporter {
    static var outputDirectory = URL(fileURLWithPath: "/", isDirectory: true)

    static func saveImages(from pasteboard: NSPasteboard, to outputDirectory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        let payloads = try readPayloads(from: pasteboard)
        guard !payloads.isEmpty else {
            throw CaptureFailure.noSupportedPasteboardContent
        }

        let operationID = UUID().uuidString.lowercased()
        var pngDataItems: [Data] = []

        for payload in payloads {
            switch payload {
            case .imageData(let data):
                pngDataItems.append(try pngData(from: data))
            case .image(let image):
                pngDataItems.append(try pngData(from: image))
            case .pdfData(let data):
                pngDataItems.append(contentsOf: try pngPages(from: data))
            case .file(let url):
                let data = try Data(contentsOf: url)
                if isPDF(url: url) {
                    pngDataItems.append(contentsOf: try pngPages(from: data))
                } else {
                    pngDataItems.append(try pngData(from: data))
                }
            }
        }

        guard !pngDataItems.isEmpty else {
            throw CaptureFailure.noSupportedPasteboardContent
        }

        var savedURLs: [URL] = []
        do {
            for (index, data) in pngDataItems.enumerated() {
                let suffix = pngDataItems.count == 1
                    ? ""
                    : String(format: "-%03d", index + 1)
                let destination = outputDirectory.appendingPathComponent(
                    "iphone-import-\(operationID)\(suffix).png",
                    isDirectory: false
                )
                try data.write(to: destination, options: .atomic)
                savedURLs.append(destination)
            }
        } catch {
            for url in savedURLs {
                try? FileManager.default.removeItem(at: url)
            }
            throw error
        }

        return savedURLs
    }

    private static func readPayloads(from pasteboard: NSPasteboard) throws -> [PasteboardPayload] {
        var payloads: [PasteboardPayload] = []

        for item in pasteboard.pasteboardItems ?? [] {
            if let type = item.types.first(where: isPDFType),
               let data = item.data(forType: type) {
                payloads.append(.pdfData(data))
                continue
            }

            if let type = preferredImageType(from: item.types),
               let data = item.data(forType: type) {
                payloads.append(.imageData(data))
            }
        }

        if !payloads.isEmpty {
            return payloads
        }

        let fileURLs = (pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: nil
        ) as? [NSURL] ?? []).map { $0 as URL }

        for url in fileURLs where url.isFileURL && supportedImageOrPDF(url: url) {
            payloads.append(.file(url))
        }

        if !payloads.isEmpty {
            return payloads
        }

        let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage] ?? []
        payloads.append(contentsOf: images.map(PasteboardPayload.image))

        if !payloads.isEmpty {
            return payloads
        }

        for type in pasteboard.types ?? [] {
            if isPDFType(type), let data = pasteboard.data(forType: type) {
                payloads.append(.pdfData(data))
            } else if isImageType(type), let data = pasteboard.data(forType: type) {
                payloads.append(.imageData(data))
            }
        }

        return payloads
    }

    private static func preferredImageType(from types: [NSPasteboard.PasteboardType]) -> NSPasteboard.PasteboardType? {
        types.first(where: isImageType)
    }

    private static func isPDFType(_ type: NSPasteboard.PasteboardType) -> Bool {
        guard let uniformType = UTType(type.rawValue) else { return false }
        return uniformType.conforms(to: .pdf)
    }

    private static func isImageType(_ type: NSPasteboard.PasteboardType) -> Bool {
        guard let uniformType = UTType(type.rawValue) else { return false }
        return uniformType.conforms(to: .image)
    }

    private static func supportedImageOrPDF(url: URL) -> Bool {
        guard url.isFileURL,
              let type = UTType(filenameExtension: url.pathExtension) else {
            return false
        }
        return type.conforms(to: .image) || type.conforms(to: .pdf)
    }

    private static func isPDF(url: URL) -> Bool {
        UTType(filenameExtension: url.pathExtension)?.conforms(to: .pdf) == true
    }

    private static func pngData(from sourceData: Data) throws -> Data {
        if let bitmap = NSBitmapImageRep(data: sourceData),
           let png = bitmap.representation(using: .png, properties: [:]) {
            return png
        }

        guard let image = NSImage(data: sourceData) else {
            throw CaptureFailure.cannotDecodeImage
        }
        return try pngData(from: image)
    }

    private static func pngData(from image: NSImage) throws -> Data {
        if let tiffData = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiffData),
           let png = bitmap.representation(using: .png, properties: [:]) {
            return png
        }

        var proposedRect = CGRect(origin: .zero, size: image.size)
        guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
            throw CaptureFailure.cannotDecodeImage
        }
        let bitmap = NSBitmapImageRep(cgImage: cgImage)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw CaptureFailure.cannotDecodeImage
        }
        return png
    }

    private static func pngPages(from pdfData: Data) throws -> [Data] {
        guard let document = PDFDocument(data: pdfData), document.pageCount > 0 else {
            throw CaptureFailure.cannotDecodePDF
        }

        var pages: [Data] = []
        pages.reserveCapacity(document.pageCount)
        for pageIndex in 0..<document.pageCount {
            guard let page = document.page(at: pageIndex) else {
                throw CaptureFailure.cannotRenderPDFPage(pageIndex + 1)
            }
            pages.append(try pngData(from: page, index: pageIndex + 1))
        }
        return pages
    }

    private static func pngData(from page: PDFPage, index: Int) throws -> Data {
        let bounds = page.bounds(for: .mediaBox).standardized
        guard bounds.width > 0, bounds.height > 0 else {
            throw CaptureFailure.cannotRenderPDFPage(index)
        }

        let maximumDimension: CGFloat = 6000
        let pointsPerInch: CGFloat = 72
        let targetPixelsPerInch: CGFloat = 300
        let scale = min(
            targetPixelsPerInch / pointsPerInch,
            maximumDimension / max(bounds.width, bounds.height)
        )
        let width = max(1, Int(ceil(bounds.width * scale)))
        let height = max(1, Int(ceil(bounds.height * scale)))

        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
            throw CaptureFailure.cannotRenderPDFPage(index)
        }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphicsContext
        let context = graphicsContext.cgContext
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.saveGState()
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: context)
        context.restoreGState()
        graphicsContext.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()

        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw CaptureFailure.cannotRenderPDFPage(index)
        }
        return png
    }
}

@MainActor
private final class CaptureApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let resultFile: URL
    private let cancelFile: URL?
    private var window: NSWindow?
    private var cancelFileTimer: Timer?
    private var didFinish = false

    init(resultFile: URL, cancelFile: URL?) {
        self.resultFile = resultFile
        self.cancelFile = cancelFile
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 270),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Import from iPhone"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 440, height: 240)
        window.delegate = self

        let content = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = content

        let heading = NSTextField(labelWithString: "Import from iPhone")
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.translatesAutoresizingMaskIntoConstraints = false

        let instructions = NSTextField(wrappingLabelWithString: "Right-click in the field below, then choose Import from iPhone → Take Photo or Scan Documents.")
        instructions.font = .systemFont(ofSize: 13)
        instructions.translatesAutoresizingMaskIntoConstraints = false

        let textView = CaptureTextView(frame: .zero)
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.allowsUndo = false
        textView.font = .systemFont(ofSize: 13)
        textView.onCapture = { [weak self] urls in self?.finishWithSuccess(urls) }
        textView.onFailure = { [weak self] error in self?.finishWithError(error) }
        textView.onCancel = { [weak self] in self?.finishAsCancelled() }

        let scrollView = NSScrollView()
        scrollView.borderType = .bezelBorder
        scrollView.hasVerticalScroller = true
        scrollView.documentView = textView
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancelButtonPressed(_:)))
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.translatesAutoresizingMaskIntoConstraints = false

        content.addSubview(heading)
        content.addSubview(instructions)
        content.addSubview(scrollView)
        content.addSubview(cancelButton)

        NSLayoutConstraint.activate([
            heading.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            heading.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            heading.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),

            instructions.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 8),
            instructions.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
            instructions.trailingAnchor.constraint(equalTo: heading.trailingAnchor),

            scrollView.topAnchor.constraint(equalTo: instructions.bottomAnchor, constant: 12),
            scrollView.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: cancelButton.topAnchor, constant: -12),
            scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 72),

            cancelButton.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
            cancelButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14)
        ])

        self.window = window
        window.center()
        window.initialFirstResponder = textView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        beginWatchingCancelFile()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        finishAsCancelled()
    }

    @objc private func cancelButtonPressed(_ sender: Any?) {
        finishAsCancelled()
    }

    private func finishWithSuccess(_ urls: [URL]) {
        guard !didFinish else { return }
        didFinish = true
        cancelFileTimer?.invalidate()

        var result: [String: Any] = ["status": "success"]
        if urls.count == 1, let url = urls.first {
            result["path"] = url.standardizedFileURL.path
        } else {
            result["paths"] = urls.map { $0.standardizedFileURL.path }
        }
        writeResultFile(result, to: resultFile)
        NSApp.terminate(nil)
    }

    private func finishAsCancelled() {
        guard !didFinish else { return }
        didFinish = true
        cancelFileTimer?.invalidate()
        writeResultFile(["status": "cancelled"], to: resultFile)
        NSApp.terminate(nil)
    }

    private func finishWithError(_ error: Error) {
        guard !didFinish else { return }
        didFinish = true
        cancelFileTimer?.invalidate()
        writeResultFile(["status": "error", "message": error.localizedDescription], to: resultFile)
        writeStderr("codex-renderer continuity helper: \(error.localizedDescription)\n")
        Darwin.exit(EXIT_FAILURE)
    }

    private func beginWatchingCancelFile() {
        guard let cancelFile else { return }
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard FileManager.default.fileExists(atPath: cancelFile.path) else { return }
                self?.finishAsCancelled()
            }
        }
        cancelFileTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
}

@MainActor
@main
private enum CodexRendererContinuityMain {
    static func main() {
        do {
            let helperArguments = try parseArguments(arguments: CommandLine.arguments)
            PasteboardImporter.outputDirectory = helperArguments.outputDirectory

            let application = NSApplication.shared
            application.setActivationPolicy(.accessory)
            let delegate = CaptureApplicationDelegate(
                resultFile: helperArguments.resultFile,
                cancelFile: helperArguments.cancelFile
            )
            application.delegate = delegate
            application.run()
        } catch {
            writeStderr("codex-renderer continuity helper: \(error.localizedDescription)\n")
            Darwin.exit(EX_USAGE)
        }
    }

    private static func parseArguments(arguments: [String]) throws -> HelperArguments {
        var outputDirectoryPath: String?
        var resultFilePath: String?
        var cancelFilePath: String?
        var index = 1

        while index < arguments.count {
            let flag = arguments[index]
            guard flag == "--output-dir" || flag == "--result-file" || flag == "--cancel-file" else {
                throw CaptureFailure.unknownArgument(flag)
            }
            guard arguments.indices.contains(index + 1),
                  !arguments[index + 1].hasPrefix("--") else {
                throw CaptureFailure.missingArgumentValue(flag)
            }

            let value = arguments[index + 1]
            if flag == "--output-dir" {
                outputDirectoryPath = value
            } else if flag == "--result-file" {
                resultFilePath = value
            } else {
                cancelFilePath = value
            }
            index += 2
        }

        guard let outputDirectoryPath else {
            throw CaptureFailure.missingOutputDirectory
        }
        guard let resultFilePath else {
            throw CaptureFailure.missingResultFile
        }
        guard outputDirectoryPath.hasPrefix("/") else {
            throw CaptureFailure.pathMustBeAbsolute("--output-dir")
        }
        guard resultFilePath.hasPrefix("/") else {
            throw CaptureFailure.pathMustBeAbsolute("--result-file")
        }
        if let cancelFilePath, !cancelFilePath.hasPrefix("/") {
            throw CaptureFailure.pathMustBeAbsolute("--cancel-file")
        }

        return HelperArguments(
            outputDirectory: URL(fileURLWithPath: outputDirectoryPath, isDirectory: true).standardizedFileURL,
            resultFile: URL(fileURLWithPath: resultFilePath, isDirectory: false).standardizedFileURL,
            cancelFile: cancelFilePath.map { URL(fileURLWithPath: $0, isDirectory: false).standardizedFileURL }
        )
    }
}

private func writeResultFile(_ object: [String: Any], to resultFile: URL) {
    do {
        let json = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        var line = json
        line.append(0x0a)
        try FileManager.default.createDirectory(
            at: resultFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try line.write(to: resultFile, options: .atomic)
    } catch {
        writeStderr("codex-renderer continuity helper: could not write result file: \(error.localizedDescription)\n")
        Darwin.exit(EXIT_FAILURE)
    }
}

private func writeStderr(_ message: String) {
    FileHandle.standardError.write(Data(message.utf8))
}
