$ErrorActionPreference = "Stop"

Write-Host "Starting catalog generation..." -ForegroundColor Cyan

function Get-RelativePath {
  param(
    [Parameter(Mandatory=$true)][string]$Base,
    [Parameter(Mandatory=$true)][string]$Full
  )
  $baseUri = New-Object System.Uri(($Base.TrimEnd('\') + '\'))
  $fullUri = New-Object System.Uri($Full)
  $rel = $baseUri.MakeRelativeUri($fullUri).ToString()
  return [System.Uri]::UnescapeDataString(($rel -replace '/', '\'))
}

function Test-ImageFile {
  param([Parameter(Mandatory=$true)][string]$Path)
  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  return @(".jpg", ".jpeg", ".png", ".webp", ".gif") -contains $ext
}

function Get-SortedColorwayImages {
  param([Parameter(Mandatory=$true)][System.Collections.IEnumerable]$Files)
  $list = @($Files)
  if ($list.Count -eq 0) { return @() }

  $allNumericNames = $true
  foreach ($f in $list) {
    if ($f.BaseName -notmatch '^\d+$') {
      $allNumericNames = $false
      break
    }
  }

  if ($allNumericNames) {
    return $list | Sort-Object @{ Expression = { [long]$_.BaseName }; Ascending = $true }, FullName
  }
  return $list | Sort-Object FullName
}

$root = (Get-Location).Path
Write-Host "Scanning directory: $root" -ForegroundColor Yellow

$brandDirs = Get-ChildItem -Path $root -Directory | Where-Object { $_.Name -notin @(".git", "node_modules") }

$items = New-Object System.Collections.Generic.List[object]

foreach ($brand in $brandDirs) {
  $hasImages = Get-ChildItem -Path $brand.FullName -Recurse -File -ErrorAction SilentlyContinue | Where-Object { Test-ImageFile $_.FullName } | Select-Object -First 1
  if (-not $hasImages) { continue }

  Write-Host "Found brand folder: $($brand.Name)" -ForegroundColor DarkCyan

  $modelDirs = Get-ChildItem -Path $brand.FullName -Directory -ErrorAction SilentlyContinue
  foreach ($model in $modelDirs) {
    $imageFiles = Get-ChildItem -Path $model.FullName -Recurse -File -ErrorAction SilentlyContinue | Where-Object { Test-ImageFile $_.FullName } | Sort-Object FullName
    if (-not $imageFiles -or $imageFiles.Count -eq 0) { continue }

    $groups = $imageFiles | Group-Object { $_.Directory.FullName }
    foreach ($g in $groups) {
      $dir = $g.Name
      $dirName = Split-Path -Path $dir -Leaf
      $parentDir = Split-Path -Path $dir -Parent

      $colorway = $dirName
      $variant = ""
      if ($parentDir -and ((Split-Path -Path $parentDir -Leaf) -ne $model.Name)) {
        $variant = Get-RelativePath -Base $model.FullName -Full $parentDir
      }

      $imagesRel = @()
      foreach ($f in (Get-SortedColorwayImages -Files $g.Group)) {
        $imagesRel += (Get-RelativePath -Base $root -Full $f.FullName)
      }

      if ($imagesRel.Count -eq 0) { continue }

      $cover = $imagesRel[0]
      $id = (($brand.Name + "|" + $model.Name + "|" + $variant + "|" + $colorway).ToLowerInvariant())

      $items.Add([pscustomobject]@{
        id = $id
        brand = $brand.Name
        model = $model.Name
        variant = $variant
        colorway = $colorway
        cover = $cover
        images = $imagesRel
      }) | Out-Null
    }
  }
}

Write-Host "Sorting and building data..." -ForegroundColor Yellow
$itemsSorted = $items | Sort-Object brand, model, variant, colorway

$out = [pscustomobject]@{
  build = [pscustomobject]@{
    generatedAt = (Get-Date).ToString("o")
    root = $root
    itemCount = ($itemsSorted | Measure-Object).Count
  }
  items = $itemsSorted
}

Write-Host "Converting to JS format..." -ForegroundColor Yellow
$json = $out | ConvertTo-Json -Depth 12
$jsContent = "window.CATALOG_DATA = " + $json + ";"
$target = Join-Path $root "catalogData.js"

$jsContent | Out-File -FilePath $target -Encoding UTF8

Write-Host "====================================" -ForegroundColor Cyan
Write-Host ("Wrote {0} items to {1}" -f $out.build.itemCount, $target) -ForegroundColor Green
Write-Host "Success! You no longer need to run a server. Just double-click index.html!" -ForegroundColor Green