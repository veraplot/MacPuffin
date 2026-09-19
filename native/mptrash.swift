// mptrash — move paths to the Trash through the sanctioned macOS API.
//
// `FileManager.trashItem` is what Finder itself uses: it records the original
// location so "Put Back" works, and it handles cross-volume and permission
// cases that a bare rename(2) cannot. Reads paths as arguments, prints one JSON
// array of results on stdout. It never deletes anything outright.

import Foundation

var results: [[String: Any]] = []

for argument in CommandLine.arguments.dropFirst() {
    let url = URL(fileURLWithPath: argument)
    var destination: NSURL?
    do {
        try FileManager.default.trashItem(at: url, resultingItemURL: &destination)
        results.append([
            "path": argument,
            "ok": true,
            "dest": destination?.path ?? "",
        ])
    } catch {
        let nsError = error as NSError
        results.append([
            "path": argument,
            "ok": false,
            "code": nsError.code,
            "error": nsError.localizedDescription,
        ])
    }
}

let data = try JSONSerialization.data(withJSONObject: results, options: [])
FileHandle.standardOutput.write(data)
