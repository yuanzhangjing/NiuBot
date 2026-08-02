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
request.recognitionLanguages = ["zh-Hans", "en"]

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
