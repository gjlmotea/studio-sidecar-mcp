import { describe, expect, it } from 'vitest';

import {
  assertArchivable,
  AssetTypeError,
  inferAssetType,
  resolveUpload,
} from '../../src/domain/asset-types.js';

describe('inferAssetType', () => {
  it.each([
    ['ship.fbx', 'Model'],
    ['icon.png', 'Decal'],
    ['icon.TGA', 'Decal'],
    ['theme.mp3', 'Audio'],
    ['theme.ogg', 'Audio'],
  ])('%s → %s', (path, expected) => {
    expect(inferAssetType(path)).toBe(expected);
  });

  it.each(['model.obj', 'model.stl', 'model.glb', 'noextension'])('推不出來時回 undefined：%s', (path) => {
    expect(inferAssetType(path)).toBeUndefined();
  });
});

describe('resolveUpload', () => {
  it('Model 只吃 fbx', () => {
    expect(resolveUpload('Model', 'a.fbx').contentType).toBe('model/fbx');
    // Open Cloud 對 Model 只接受 fbx；obj/glb 要等輪詢 operation 才會失敗，先在本機擋掉。
    expect(() => resolveUpload('Model', 'a.obj')).toThrow(AssetTypeError);
  });

  it('Decal 的 Content-Type 跟著副檔名走', () => {
    expect(resolveUpload('Decal', 'a.png').contentType).toBe('image/png');
    expect(resolveUpload('Decal', 'a.jpg').contentType).toBe('image/jpeg');
    expect(resolveUpload('Decal', 'a.bmp').contentType).toBe('image/bmp');
  });

  it('Audio 區分 mp3 與 ogg', () => {
    expect(resolveUpload('Audio', 'a.mp3').contentType).toBe('audio/mpeg');
    expect(resolveUpload('Audio', 'a.ogg').contentType).toBe('audio/ogg');
  });

  it('副檔名比對不分大小寫', () => {
    expect(resolveUpload('Model', 'A.FBX').contentType).toBe('model/fbx');
  });
});

describe('assertArchivable', () => {
  it('Model 從未支援封存，先擋下來而不是讓呼叫端重試', () => {
    expect(() => assertArchivable('Model')).toThrow(AssetTypeError);
    expect(() => assertArchivable('Model')).toThrow(/不是可封存的型別/);
  });

  it('Audio 可以封存', () => {
    expect(() => assertArchivable('Audio')).not.toThrow();
  });
});
