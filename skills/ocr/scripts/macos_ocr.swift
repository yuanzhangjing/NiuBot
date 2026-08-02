// macOS 系统自带 OCR（Vision 框架）
// 用法: xcrun swift macos_ocr.swift <图片路径>
import Vision
import CoreImage
import Foundation

guard CommandLine.arguments.count > 1 else {
    print("用法: xcrun swift macos_ocr.swift <图片路径>")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
guard let image = CIImage(contentsOf: URL(fileURLWithPath: imagePath)) else {
    print("错误: 无法加载图片: \(imagePath)")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// 与系统可用语言求交，避免硬编码语言在未下载识别数据的系统上抛错。
// 查询失败或交集为空时不设置该属性（Vision 用系统默认语言），
// 不传空数组（空语言数组非法会抛错）。
let desired = ["zh-Hans", "en"]
let supported = Set((try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: VNRecognizeTextRequest.currentRevision)) ?? [])
let available = desired.filter { supported.contains($0) }
if !available.isEmpty {
  request.recognitionLanguages = available
}

let handler = VNImageRequestHandler(ciImage: image)
do {
    try handler.perform([request])
} catch {
    print("错误: \(error)")
    exit(1)
}

guard let observations = request.results, !observations.isEmpty else {
    print("(未识别到文字)")
    exit(0)
}

for observation in observations {
    guard let topCandidate = observation.topCandidates(1).first else { continue }
    print("[\(String(format: "%.2f", topCandidate.confidence))] \(topCandidate.string)")
}
