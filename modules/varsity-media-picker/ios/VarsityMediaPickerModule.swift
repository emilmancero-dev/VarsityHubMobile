import ExpoModulesCore
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import ImageIO

public class VarsityMediaPickerModule: Module {
  private var session: MediaPickerSession?

  public func definition() -> ModuleDefinition {
    Name("VarsityMediaPicker")
    AsyncFunction("prepareDraftDirectory") { () -> String in
      var directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("MediaDrafts", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      return directory.absoluteString
    }
    AsyncFunction("launchLibrary") { (includeImages: Bool, selectionLimit: Int, promise: Promise) in
      guard self.session == nil else {
        promise.reject("ERR_PICKER_BUSY", "A media selection is already in progress.")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_PICKER_PRESENTATION", "Could not open the photo library.")
        return
      }
      let session = MediaPickerSession(promise: promise) { [weak self] in self?.session = nil }
      self.session = session
      var configuration = PHPickerConfiguration()
      configuration.filter = includeImages ? .any(of: [.images, .videos]) : .videos
      configuration.selectionLimit = max(1, selectionLimit)
      // Request the existing representation. No AVAssetExportSession or codec conversion.
      configuration.preferredAssetRepresentationMode = .current
      configuration.selection = .ordered
      let picker = PHPickerViewController(configuration: configuration)
      picker.delegate = session
      presenter.present(picker, animated: true)
      picker.presentationController?.delegate = session
    }.runOnQueue(DispatchQueue.main)
  }
}

private final class MediaPickerSession: NSObject, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private let promise: Promise
  private let finish: () -> Void
  private var completed = false

  init(promise: Promise, finish: @escaping () -> Void) {
    self.promise = promise
    self.finish = finish
  }

  private func cancel() {
    guard !completed else { return }
    completed = true
    promise.resolve(["canceled": true, "assets": NSNull()] as [String: Any])
    finish()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { cancel() }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard !results.isEmpty else { cancel(); return }
    // Mark selection complete before dismissal, so interactive-dismiss callbacks
    // cannot resolve the promise while the selected files are being downloaded.
    guard !completed else { return }
    completed = true
    Task {
      var assets: [[String: Any]] = []
      var copiedFiles: [URL] = []
      do {
        for result in results {
          let provider = result.itemProvider
          let video = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
          let file = try await copyRepresentation(provider, video: video)
          copiedFiles.append(file)
          assets.append(try await metadata(file, video: video, assetId: result.assetIdentifier))
        }
        await MainActor.run {
          promise.resolve(["canceled": false, "assets": assets])
          finish()
        }
      } catch {
        for file in copiedFiles { try? FileManager.default.removeItem(at: file) }
        await MainActor.run {
          promise.reject("ERR_MEDIA_ACQUISITION", "Unable to open the selected media. Please try another file.")
          finish()
        }
      }
    }
  }

  private func copyRepresentation(_ provider: NSItemProvider, video: Bool) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      // The system provider owns iCloud download and limited-library access. Its
      // temporary URL is valid only inside this callback; copy before returning.
      provider.loadFileRepresentation(forTypeIdentifier: video ? UTType.movie.identifier : UTType.image.identifier) { source, error in
        guard let source = source else {
          continuation.resume(throwing: error ?? NSError(domain: "VarsityMediaPicker", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The selected media could not be read."]))
          return
        }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("MediaDrafts", isDirectory: true)
        let destination = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(source.pathExtension)
        do {
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          var draftDirectory = directory
          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          try draftDirectory.setResourceValues(values)
          try FileManager.default.copyItem(at: source, to: destination)
          continuation.resume(returning: destination)
        } catch {
          try? FileManager.default.removeItem(at: destination)
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func metadata(_ file: URL, video: Bool, assetId: String?) async throws -> [String: Any] {
    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size > 0 else { throw NSError(domain: "VarsityMediaPicker", code: 2,
      userInfo: [NSLocalizedDescriptionKey: "The selected file is empty."]) }
    var result: [String: Any] = ["uri": file.absoluteString, "type": video ? "video" : "image",
      "fileName": file.lastPathComponent, "fileSize": size, "width": 0, "height": 0]
    if let assetId = assetId { result["assetId"] = assetId }
    if let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType { result["mimeType"] = mime }
    if video {
      let asset = AVURLAsset(url: file)
      let duration = try await asset.load(.duration)
      let seconds = CMTimeGetSeconds(duration)
      guard seconds.isFinite && seconds > 0 else { throw NSError(domain: "VarsityMediaPicker", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "The video duration could not be read."]) }
      result["duration"] = seconds * 1000
      if let track = try await asset.loadTracks(withMediaType: .video).first {
        let naturalSize = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let displaySize = naturalSize.applying(transform)
        result["width"] = abs(displaySize.width)
        result["height"] = abs(displaySize.height)
      }
    } else if let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
      let width = properties[kCGImagePropertyPixelWidth] as? Int ?? 0
      let height = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
      let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
      result["width"] = (5...8).contains(orientation) ? height : width
      result["height"] = (5...8).contains(orientation) ? width : height
    }
    return result
  }
}
