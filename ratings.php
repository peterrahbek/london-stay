<?php
/**
 * ratings.php — London Shortlist collaborative ratings API
 * No database. Stores ratings in ratings.json (same directory).
 * Usage:
 *   GET  ratings.php          → returns full ratings JSON
 *   POST ratings.php          → body: JSON patch, merges per-user and returns updated ratings
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

$file = __DIR__ . '/ratings.json';

// ---- GET ----
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (file_exists($file)) {
        echo file_get_contents($file);
    } else {
        echo '{}';
    }
    exit;
}

// ---- POST ----
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = file_get_contents('php://input');
    $incoming = json_decode($body, true);
    if (!is_array($incoming)) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid JSON body']);
        exit;
    }

    // Load existing
    $existing = [];
    if (file_exists($file)) {
        $existing = json_decode(file_get_contents($file), true) ?: [];
    }

    // Merge: incoming overwrites per user per property
    // Structure: { "propId": { "peter": { "stars": 4, "comment": "..." }, ... } }
    foreach ($incoming as $propId => $users) {
        if (!isset($existing[$propId])) {
            $existing[$propId] = [];
        }
        foreach ($users as $user => $data) {
            if (isset($data['stars']) || isset($data['comment'])) {
                $existing[$propId][$user] = $data;
            }
        }
    }

    // Write back (with file locking to handle concurrent saves)
    $json = json_encode($existing, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    $fh = fopen($file, 'c');
    if ($fh && flock($fh, LOCK_EX)) {
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, $json);
        fflush($fh);
        flock($fh, LOCK_UN);
        fclose($fh);
        echo json_encode(['ok' => true, 'saved' => date('c')]);
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'Could not write ratings.json — check file permissions']);
    }
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
