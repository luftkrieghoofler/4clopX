<?php
// Copy beside actions.php. This is a read-only JSON dump of CLOP's static
// resource and recipe tables; login is required, but the data is not scoped
// to the current nation.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    header('Allow: GET');
    http_response_code(405);
    echo json_encode(array('error' => 'GET only'));
    exit;
}

require_once __DIR__ . '/backend/allfunctions.php';
needsuser();

// This fixed allow-list is deliberately not influenced by request data.
$tables = array(
    'recipegroups',
    'recipes',
    'recipeitems',
    'resourcedefs',
    'resourceeffects',
    'resourcerequirements',
    'weapondefs',
    'weaponrecipes',
    'weaponrecipeitems',
    'armordefs',
    'armorrecipes',
    'armorrecipeitems',
);

$data = array('schemaVersion' => 1);
foreach ($tables as $table) {
    $result = $GLOBALS['mysqli']->query("SELECT * FROM `{$table}`");
    if (!$result) {
        error_log("actiondata.php: could not read {$table}: " . $GLOBALS['mysqli']->error);
        http_response_code(500);
        echo json_encode(array('error' => 'Could not load game data'));
        exit;
    }

    $data[$table] = array();
    while ($row = mysqli_fetch_assoc($result)) {
        $data[$table][] = $row;
    }
}

echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
