# 切り抜き
ブラウザ内で位置指定による画像切り抜きを行う静的Webアプリ。複数画像を読み込み、写真上で残したいものをクリックすると、クリックごとに別の選択として追加する。元写真と仕上がりを常に並べ、選んだものは画像付きの一覧から個別に取り消し・修正できる。細かな範囲の候補や輪郭調整は「仕上がりを調整」にまとめた。元解像度の透過PNGと、完成した複数画像のZIP保存に対応する。
## GitHub Actionsでのデプロイ

1. ZIPを展開し、`kirinuki-studio/`の中身をGitHubリポジトリのルートへ配置する。`.github/`も含める。
2. GitHubリポジトリの **Settings → Pages → Build and deployment → Source** で **GitHub Actions** を選ぶ。
3. `main`ブランチへpushする。既にpush済みなら **Actions → Deploy to GitHub Pages → Run workflow** で手動実行する。

`.github/workflows/deploy-pages.yml`がJavaScriptの構文、モデルキャッシュ、編集状態と透過PNG出力を検証し、`dist/`をGitHub Pagesへデプロイする。アプリ自体はビルド不要。Actions内ではテスト用にのみ`@napi-rs/canvas`を一時フォルダに取得する。既定ブランチが`main`以外の場合はworkflowの`branches`を変更する。完了後の公開URLはActionsの`github-pages`環境から開ける。

モデルとService WorkerのURLは配置先から解決するため、`https://<owner>.github.io/<repository>/`と独自ドメインの両方に対応する。キャッシュのキーも配置先とモデルリビジョンで分ける。

このZIPのActionsはまだGitHub上で実行していない。個人の写真およびデバッグ用画像は配布物に含めない。

GitHub公式の手順: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages

## 実行
`dist/`をHTTPSで配信する。添付されたcoi-serviceworker v0.1.7を基に、モデル配信処理への分岐だけを追加した。初回はService Workerによる再読み込みが発生する。COOP/COEPでクロスオリジン分離し、ONNX RuntimeのWASMスレッド数を利用可能な論理コア数（最大8）に設定する。WebGPUを優先し、利用できない場合はWASMへ移行して画面に表示する。HTTPの非localhost環境ではService Workerを利用できない。
## モデルとランタイム
モデルはHugging Faceの公開resolve APIから取得するXenova/slimsam-77-uniform（Apache-2.0）。リビジョンは`5850ab45f587c112167512ffef949107115e26a0`。モデル精度はFP32、推論用画像の長辺は最大1024px。元画像は保持し、透過マスクを元の寸法に拡大して出力する。髪、透明物、細い輪郭のマッティング専用モデルではない。
Transformers.js 3.5.0と、その配布物に同梱されたONNX Runtime WebをjsDelivrから読み込む。WASMとJavaScriptのバージョンを混在させない。画像と点座標を外部へ送信する処理はなく、画像解析は専用Web Workerで行う。ZIP出力にはfflate 0.8.2をjsDelivrから読み込む。
## キャッシュと検証
Service Workerがモデルをストリーム受信し、50,000,000バイトを上限に分割して`kirinuki-model-parts-v1` Cache Storageへ保存する。ONNXファイルはそれぞれ約23.28MBと16.56MBのため、現モデルでは各1チャンク。50MBを超える入力の分割処理もテスト済み。
hash-wasm 4.12.0のxxHash64（seed 0）で、初回取得時とキャッシュからの読み込み時に全バイトを検証する。固定リビジョンの配布ファイルから得た期待値は、vision_encoder.onnx: `66ab8e4a5a44439c`、prompt_encoder_mask_decoder.onnx: `cc11b9de008291cb`。サイズも一致を確認する。xxHashは破損検出用で、暗号学的な署名ではない。
検証成功後だけ完了manifestを書き込む。キャッシュが欠落・破損していれば当該モデルのチャンクを破棄して再取得する。ネットワークから取得したモデルも検証に失敗すれば推論に渡さない。ブラウザによる保存領域の削除時は再取得される。Transformers.js側の別キャッシュは無効化し、モデルを二重保存しない。
## 検証
`node verify-editor.cjs <@napi-rs/canvasモジュールの絶対パス>`で、既知のマスクを使った編集状態とPNG出力を検証する。実モデルの推論を代替するテストではない。Actionsでは`@napi-rs/canvas@0.1.100`を使用する。

`node verify-cache.cjs <hash-wasmのxxhash64 CommonJSモジュールの絶対パス>`で、GitHub Pagesのサブパス解決、本番と同じ50MB分割・復元、キャッシュ再利用、破損修復、不正ダウンロード拒否を確認する。テストはService Workerのストレージとfetchをメモリ上で置き換え、実際のmodel-cache.jsを実行する。Actions内でも同じテストを実行する。
Sites内部プレビューで添付6画像の読み込み、連続クリックによる複数選択、除外、取り消し、画像切り替え時の状態保持を確認。実際のapp.jsをNode上で実行する検証では、既知のマスク入力による合成、透過PNGのアルファ・寸法、切り詰め、処理途中の保存抑止、取り消し後の古い応答の無視を確認した。内部プレビューはHTTPでService Worker/WebGPUを利用できず、この環境での実モデルを使ったブラウザ推論・実ブラウザ上のマルチスレッド動作は未検証。
## 配布物
個人の写真、デバッグ用画像、サンプル画像の読み込み機能は含めない。添付coi-serviceworkerのMIT表記を保持。ユーザー画像をサーバーへ保存する機能はない。
