# Resize the mascot source art into badge-sized, web-served PNGs.
#
# Why a committed script rather than a one-off command: the sources are
# 1122x1402 and about 1.5 MB each, which is fine for art and far too heavy to
# ship to a browser badge that renders at ~96 logical pixels. Whoever replaces
# the art later needs to be able to regenerate the derivatives the same way.
#
# Uses System.Drawing rather than sharp: sharp is present in the desktop app's
# node_modules but is built for Electron's Node ABI, so it does not load under a
# plain system Node. System.Drawing is part of the framework, honours alpha, and
# is deterministic.
#
#   pwsh -File scripts/resize-mascot.ps1
#
# Output lands beside the sources under assets/mascot/<size>/, and the badge
# picks a size by name.

[CmdletBinding()]
param(
  # Heights to generate. 320 serves 2x for a 160px display; 200 covers a 96px
  # display at 2x; 128 covers the 64px compact display at 2x.
  [int[]] $Heights = @(320, 200, 128),
  [string] $SourceDirectory = (Join-Path $PSScriptRoot '..\assets\mascot'),
  [int] $Quality = 88
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourceDir = (Resolve-Path $SourceDirectory).Path
$sources = Get-ChildItem -Path $sourceDir -Filter '*.png' -File | Where-Object { $_.DirectoryName -eq $sourceDir }

if ($sources.Count -eq 0) {
  throw "no source PNGs found directly under $sourceDir"
}

Write-Host "sources: $($sources.Count) in $sourceDir"

foreach ($height in $Heights) {
  $targetDir = Join-Path $sourceDir $height
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  foreach ($source in $sources) {
    $image = [System.Drawing.Image]::FromFile($source.FullName)
    try {
      $width = [int][Math]::Round($image.Width * ($height / $image.Height))

      $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
          $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $graphics.DrawImage($image, 0, 0, $width, $height)
        } finally {
          $graphics.Dispose()
        }

        # 32bpp ARGB, so transparency survives: these are cut-out characters and a
        # flattened background would show as a coloured box behind the badge.
        $target = Join-Path $targetDir $source.Name
        $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $bitmap.Dispose()
      }

      $bytes = (Get-Item $target).Length
      Write-Host ("  {0,-14} {1,4}x{2,-5} {3,8:N0} bytes" -f $source.Name, $width, $height, $bytes)
    } finally {
      $image.Dispose()
    }
  }
}

$total = (Get-ChildItem -Path $sourceDir -Recurse -Filter '*.png' -File |
  Where-Object { $_.DirectoryName -ne $sourceDir } |
  Measure-Object -Property Length -Sum).Sum
Write-Host ("derivatives total: {0:N2} MB" -f ($total / 1MB))
