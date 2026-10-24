# 승강장 인물 모델

- `view-demo.html?people=1`: `restore50/`의 인물 모델 5종을 양쪽 승강장 PSD 앞에 섞어서 세웁니다. 키는 1.60~1.80m 사이에서 무작위로 정하고, 배치는 역 위치로 정한 난수라서 매번 같습니다.
- `view-demo.html?people=local`: `model-prep.html`에서 정리하고 "승강장에서 보기"를 누른 모델 하나를 씁니다. 모델은 브라우저 저장소(IndexedDB)에만 있고, 저장소에는 올라가지 않습니다.
- 이 폴더 바로 아래의 `*.glb`는 시험용으로 `.gitignore`에 들어 있습니다. 라이선스를 확인한 모델만 하위 폴더에 넣어 커밋합니다.

## 출처 (CC BY 4.0)

모두 Sketchfab 사용자 **restore50**의 "Humans for Archviz (downloadable)" 컬렉션 모델이며, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 라이선스입니다.
원본(삼각형 17만~35만 개)을 `model-prep.html`로 삼각형 약 2만 개, 텍스처 1024px(WebP)로 줄이고 크기를 실제 미터 단위로 맞췄습니다.

| 파일 | 원본 모델 |
|---|---|
| `restore50/quiet-confidence-burgundy-navy.glb` | [Quiet Confidence In Burgundy And Navy](https://sketchfab.com/3d-models/37f0a65aca7f406d9ffe99ee4e9ec0ce) |
| `restore50/green-striped-shirt-portrait.glb` | [Green Striped Shirt Portrait](https://sketchfab.com/3d-models/78b0860ed5f240a4bd526ee4b72195a3) |
| `restore50/casual-chic-black-denim.glb` | [Casual Chic In Black And Denim](https://sketchfab.com/3d-models/casual-chic-in-black-and-denim-562b0b211f1d40bebd5afcaf33c092c3) |
| `restore50/denim-casual-look-2.glb` | Denim Casual Look (restore50, [컬렉션](https://sketchfab.com/restore50/collections/humans-for-archviz-downloadable-9b83cb8702fb49d29865beeb9a8d4dbd)) |
| `restore50/casual-portrait-4.glb` | Casual Portrait (restore50, [컬렉션](https://sketchfab.com/restore50/collections/humans-for-archviz-downloadable-9b83cb8702fb49d29865beeb9a8d4dbd)) |
