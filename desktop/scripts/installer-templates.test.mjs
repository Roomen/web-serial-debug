import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const nsis = read('../installers/installer.nsi');
const wix = read('../installers/main.wxs');
const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
const windowsConfig = JSON.parse(read('../src-tauri/tauri.windows.conf.json'));

test('Windows builds only NSIS while other platforms keep all bundle targets', () => {
  assert.equal(config.bundle.targets, 'all');
  assert.deepEqual(windowsConfig.bundle.targets, ['nsis']);
  assert.equal(config.bundle.windows.nsis.template, '../installers/installer.nsi');
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.wix.template, '../installers/main.wxs');
});

test('NSIS default is conditional and previous location wins; /D stays untouched', () => {
  const init = nsis.slice(nsis.indexOf('Function .onInit'), nsis.indexOf('Section WebView2'));
  const guard = init.indexOf('${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"');
  const fallback = init.indexOf('StrCpy $INSTDIR "$LOCALAPPDATA\\${PRODUCTNAME}"');
  const rootCheck = init.indexOf('GetFileAttributesW(w "D:\\")');
  const driveGuard = init.indexOf('${If} $0 != -1', rootCheck);
  const preferred = init.indexOf('StrCpy $INSTDIR "D:\\project files\\${PRODUCTNAME}"');
  const restore = init.indexOf('Call RestorePreviousInstallLocation');
  assert.ok(guard >= 0 && guard < fallback && fallback < rootCheck);
  assert.ok(rootCheck < driveGuard && driveGuard < preferred && preferred < restore);
  assert.match(init.slice(preferred, restore), /\$\{EndIf\}/);
  assert.match(init.slice(restore), /^Call RestorePreviousInstallLocation\s+\$\{EndIf\}/);
  assert.match(nsis, /Function RestorePreviousInstallLocation\s+ReadRegStr \$4 SHCTX "\$\{MANUPRODUCTKEY\}" ""\s+StrCmp \$4 "" \+2 0\s+StrCpy \$INSTDIR \$4/);
  assert.ok(nsis.includes('!insertmacro MUI_PAGE_DIRECTORY'));
  assert.ok(nsis.includes('WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR'));
});

test('MSI restores or accepts explicit directory before applying a first-install default', () => {
  assert.match(wix, /<Property Id="INSTALLDIR" Secure="yes" \/>/);
  const previousSearch = wix.match(/<Property Id="PREVIOUS_INSTALLDIR" Secure="yes">([\s\S]*?)<\/Property>/);
  assert.ok(previousSearch);
  assert.match(previousSearch[1], /RegistrySearch Id="PrevInstallDirWithName"[^>]+Name="InstallDir"/);
  assert.equal((wix.match(/<RegistrySearch Id="PrevInstallDir/g) || []).length, 2);
  assert.match(wix, /<SetProperty Id="INSTALLDIR" Value="\[PREVIOUS_INSTALLDIR\]"\s+Action="RestorePreviousInstallDir" After="AppSearch"\s+Sequence="both">NOT INSTALLDIR AND PREVIOUS_INSTALLDIR<\/SetProperty>/);
  assert.match(wix, /DirectorySearch Id="SerialDebugDDrive" Path="D:\\" Depth="0"/);
  assert.match(wix, /<SetProperty Id="INSTALLDIR" Value="D:\\project files\\\{\{product_name\}\}"\s+Action="SetDefaultInstallDir" After="RestorePreviousInstallDir"\s+Sequence="both">NOT INSTALLDIR AND SERIALDEBUG_D_DRIVE AND NOT Installed<\/SetProperty>/);
  assert.ok(wix.includes('<UIRef Id="WixUI_InstallDir" />'));
  assert.ok(wix.includes('<Directory Id="$(var.PlatformProgramFilesFolder)" Name="PFiles">'));
  assert.ok(wix.includes('Name="InstallDir" Type="string" Value="[INSTALLDIR]"'));
});
