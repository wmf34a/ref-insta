// On-screen text recognition with macOS Vision. Usage: ocr img1.jpg img2.jpg ...
// Prints a JSON array of strings, one per image, in argument order.
import Foundation
import Vision

var out: [String] = []
for file in CommandLine.arguments.dropFirst() {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["ko-KR", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: file))
    try? handler.perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first }.filter { $0.confidence > 0.4 }.map { $0.string }
    out.append(lines.joined(separator: " "))
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
