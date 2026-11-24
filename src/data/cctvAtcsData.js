// src/data/cctvAtcsData.js
// Dataset statis titik CCTV ATCS Jabodetabek + Jawa Barat. Menggantikan query Overpass/OSM lama.
//
// Field tiap titik:
//   id, nama, wilayah (label tampilan), grup (kunci filter peta), lat, lng,
//   feeds      : daftar kamera di titik itu. Tiap feed = { label, streamUrls: [kandidat .m3u8], embedUrl }.
//                [] bila belum ada URL stream (pemutar langsung menampilkan tombol portal resmi).
//   streamUrl  : URL .m3u8 pertama dari feeds (turunan; untuk kompatibilitas)
//   portalUrl  : halaman resmi ATCS/RTTMC terkait
//   sumber     : pengelola/penyedia titik
//   koordinat  : "perkiraan" | "resmi"
//   streamStatus: "pola-flussonic" (URL .m3u8 disusun dari pola server, belum diuji) | "belum-ada" | "terverifikasi"
//
// CATATAN PENTING
//  - Koordinat "perkiraan": ambil yang benar lewat Google Maps (tekan lama di titik -> salin lat,lng) lalu ganti di sini.
//  - Alamat embed.html terbukti dipakai portal resmi. Alamat .m3u8 adalah tebakan pola: pemutar mencoba tiap kandidat
//    berurutan, lalu menawarkan pemutar embed resmi bila semuanya gagal.
//  - Menambah kamera DKI: salin nama folder dari DevTools -> Resources -> Iframe di jakcctv.jakarta.go.id/publik,
//    buang akhiran "_CCTV-0N/embed.html", lalu tambahkan dki({ id, nama, lat, lng, kode }).
//  - Server pemerintah bisa memblokir pemakaian lintas-situs (CORS) atau mengubah alamat sewaktu-waktu.

export const CCTV_GROUPS = [
  { key: "semua", label: "Semua" },
  { key: "jakarta", label: "Jakarta" },
  { key: "depok", label: "Depok" },
  { key: "bandung-cianjur", label: "Bandung/Cianjur" },
];

// ---- Portal resmi / agregator ----
const PORTAL = {
  jakartaAtcs: "https://atcs-jakarta.com/Maps",
  jakartaSmartCity: "https://smartcity.jakarta.go.id/maps/",
  baliTower: "https://cctv.balitower.co.id/",
  depok: "https://lewatmana.com/kota/depok/", // agregator swasta; URL ATCS Dishub Depok resmi belum terverifikasi
  bandungAtcs: "https://atcs-dishub.bandung.go.id",
  bandungPelindung: "https://pelindung.bandung.go.id",
  rttmc: "https://rttmc.dephub.go.id/rttmc/livecctv",
};

// ---- Struktur kamera ----
// Satu titik bisa punya beberapa kamera (feeds): tiap feed punya
//   label       : "CCTV-01"
//   streamUrls  : kandidat URL .m3u8, dicoba berurutan oleh pemutar sampai ada yang jalan
//   embedUrl    : halaman pemutar resmi (embed.html) sebagai cadangan terakhir
// Server Bali Tower memakai Flussonic: /<nama-stream>/embed.html berpasangan dengan /<nama-stream>/index.m3u8.
// Alamat embed.html terbukti dipakai portal resmi; alamat .m3u8 masih TEBAKAN pola (belum diuji dari sini).
const hlsCandidates = (base) => [`${base}/index.m3u8`, `${base}/video.m3u8`];
const feed = (base, label = "Kamera") => ({ label, streamUrls: hlsCandidates(base), embedUrl: `${base}/embed.html` });

// Portal publik resmi Pemprov DKI menanam kamera dari host ini (terlihat di daftar iframe halaman /publik).
export const DKI_HOST = "https://dki-jkt.balitower.co.id:7028";
const BT_HOST = "https://cctv.balitower.co.id"; // host lama: halaman utama tidak ada, hanya /<stream>/embed.html

const withMeta = (c) => ({ koordinat: "perkiraan", ...c, streamUrl: c.feeds && c.feeds[0] ? c.feeds[0].streamUrls[0] : null });

// Kamera Bali Tower (host lama) - satu feed per titik
const bt = (id, nama, lat, lng, stream, wilayah = "Jakarta") => withMeta({
  id, nama, wilayah, grup: "jakarta", lat, lng,
  feeds: [feed(`${BT_HOST}/${stream}`)],
  portalUrl: `${BT_HOST}/${stream}/embed.html`,
  sumber: "Jakarta Smart City / Bali Tower",
  streamStatus: "pola-flussonic",
});

// Kamera portal publik DKI (jakcctv.jakarta.go.id/publik). kode = nama folder tanpa akhiran _CCTV-0N.
const dki = ({ id, nama, lat, lng, kode, cams = [1, 2], sumber = "CCTV Publik DKI Jakarta (Polda Metro Jaya)", wilayah = "Jakarta Pusat", koordinat = "perkiraan" }) => withMeta({
  id, nama, wilayah, grup: "jakarta", lat, lng, koordinat,
  feeds: cams.map((n) => feed(`${DKI_HOST}/${kode}_CCTV-0${n}`, `CCTV-0${n}`)),
  portalUrl: "https://jakcctv.jakarta.go.id/publik",
  sumber,
  streamStatus: "pola-flussonic",
});

export const CCTV_ATCS = [
  // ===== Jakarta: portal publik resmi DKI (jakcctv.jakarta.go.id/publik) =====
  // Koordinat Halte TransJakarta Gerbang Pemuda (di Jl. Gatot Subroto, dekat JPO & flyover) = -6.2137, 106.8081 (sumber: Wikipedia).
  // Titik lain disebar di sepanjang Jl. Gerbang Pemuda dari titik itu ke arah GBK: PERKIRAAN, perbaiki lewat Google Maps (tekan lama -> salin koordinat).
  dki({ id: "dki-gatot-subroto-jpo7", nama: "JPO Jl. Gatot Subroto 7", lat: -6.2137, lng: 106.8081, kode: "502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7" }),
  dki({ id: "dki-gerbang-pemuda-c02", nama: "Jl. Gerbang Pemuda C02", lat: -6.2150, lng: 106.8068, kode: "502155_JKP_POLDA_JL.-GERBANG-PEMUDA-C02" }),
  dki({ id: "dki-gerbang-pemuda-c03", nama: "Jl. Gerbang Pemuda C03", lat: -6.2165, lng: 106.8055, kode: "502160_JKP_POLDA_JL.-GERBANG-PEMUDA-C03" }),
  dki({ id: "dki-gerbang-pemuda-c04", nama: "Jl. Gerbang Pemuda C04 (Satpol PP)", lat: -6.2180, lng: 106.8042, kode: "502506_JKP_SATPOL-PP_JL.-GERBANG-PEMUDA-C04", sumber: "CCTV Publik DKI Jakarta (Satpol PP)" }),

  // ===== Jakarta (Jakarta Smart City, Bali Tower, ATCS Dishub DKI) =====
  bt("jkt-gbk-1002", "GBK Senayan C1002", -6.2183, 106.8018, "GBKC1002", "Jakarta Pusat"),
  bt("jkt-gbk-1003", "GBK Senayan C1003", -6.2189, 106.8024, "GBKC1003", "Jakarta Pusat"),
  bt("jkt-gbk-1004", "GBK Senayan C1004", -6.2195, 106.8031, "GBKC1004", "Jakarta Pusat"),
  bt("jkt-bendungan-hilir-1", "Bendungan Hilir", -6.2146, 106.8176, "Bendungan-Hilir-003-700014_1", "Jakarta Pusat"),
  bt("jkt-bendungan-hilir-3", "Bendungan Hilir 3", -6.2149, 106.8181, "Bendungan-Hilir-003-700014_3", "Jakarta Pusat"),
  bt("jkt-pasar-manggis", "Pasar Manggis", -6.2102, 106.8467, "Pasar-Manggis-014-795129_4", "Jakarta Selatan"),
  bt("jkt-manggarai-pintu-air-1", "Pintu Air Manggarai 1", -6.2087, 106.8504, "Manggarai-Pintu-Air_1", "Jakarta Selatan"),
  bt("jkt-manggarai-pintu-air-2", "Pintu Air Manggarai 2", -6.2090, 106.8508, "Manggarai-Pintu-Air_2", "Jakarta Selatan"),
  bt("jkt-kuningan-barat-3", "Kuningan Barat", -6.2394, 106.8186, "Kuningan-Barat-003-705052_3", "Jakarta Selatan"),
  bt("jkt-kemanggisan", "Kemanggisan", -6.1946, 106.7852, "Kemanggisan-038-792405_3", "Jakarta Barat"),
  bt("jkt-cengkareng-barat", "Cengkareng Barat", -6.1425, 106.7345, "Cengkareng-Barat-013-702131_2", "Jakarta Barat"),
  withMeta({
    id: "jkt-atcs-dishub",
    nama: "ATCS Dishub DKI (peta kamera)",
    wilayah: "Jakarta Pusat",
    grup: "jakarta",
    lat: -6.1950, lng: 106.8230, // Bundaran HI (titik acuan portal)
    feeds: [],
    portalUrl: PORTAL.jakartaAtcs,
    sumber: "ATCS Dishub DKI Jakarta",
    streamStatus: "belum-ada",
  }),

  // ===== Depok =====
  withMeta({
    id: "dpk-margonda-city-center",
    nama: "Margonda Raya (Depok City Center)",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3737, lng: 106.8322,
    feeds: [],
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "dpk-terminal",
    nama: "Terminal Depok / Simpang Margonda-Juanda",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3919, lng: 106.8238,
    feeds: [],
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "dpk-lenteng-agung",
    nama: "Perbatasan Lenteng Agung - Depok",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3300, lng: 106.8346,
    feeds: [],
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  }),

  // ===== Bandung (ATCS Dishub + Pelindung) =====
  withMeta({
    id: "bdg-alun-alun",
    nama: "Alun-Alun Bandung",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9218, lng: 107.6071,
    feeds: [],
    portalUrl: PORTAL.bandungPelindung,
    sumber: "Pelindung Kota Bandung",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "bdg-asia-afrika",
    nama: "Jl. Asia Afrika",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9210, lng: 107.6097,
    feeds: [],
    portalUrl: PORTAL.bandungAtcs,
    sumber: "ATCS Dishub Kota Bandung",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "bdg-gedung-sate",
    nama: "Gedung Sate / Jl. Diponegoro",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9025, lng: 107.6186,
    feeds: [],
    portalUrl: PORTAL.bandungAtcs,
    sumber: "ATCS Dishub Kota Bandung",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "bdg-pasteur",
    nama: "Simpang Pasteur",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.8977, lng: 107.5946,
    feeds: [],
    portalUrl: PORTAL.bandungPelindung,
    sumber: "Pelindung Kota Bandung",
    streamStatus: "belum-ada",
  }),

  // ===== Jalur Puncak - Cianjur (RTTMC Kemenhub) =====
  withMeta({
    id: "pck-gadog",
    nama: "Simpang Gadog (Puncak)",
    wilayah: "Kab. Bogor",
    grup: "bandung-cianjur",
    lat: -6.6567, lng: 106.8636,
    feeds: [],
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "pck-cisarua",
    nama: "Cisarua (Puncak)",
    wilayah: "Kab. Bogor",
    grup: "bandung-cianjur",
    lat: -6.6813, lng: 106.9400,
    feeds: [],
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "pck-puncak-pass",
    nama: "Puncak Pass",
    wilayah: "Kab. Bogor / Cianjur",
    grup: "bandung-cianjur",
    lat: -6.7035, lng: 106.9990,
    feeds: [],
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "cjr-cipanas",
    nama: "Cipanas",
    wilayah: "Kab. Cianjur",
    grup: "bandung-cianjur",
    lat: -6.7494, lng: 107.0293,
    feeds: [],
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  }),
  withMeta({
    id: "cjr-kota",
    nama: "Cianjur Kota",
    wilayah: "Kab. Cianjur",
    grup: "bandung-cianjur",
    lat: -6.8200, lng: 107.1430,
    feeds: [],
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  }),
];

export const filterCctv = (grup) => (!grup || grup === "semua" ? CCTV_ATCS : CCTV_ATCS.filter((c) => c.grup === grup));
export const findCctv = (id) => CCTV_ATCS.find((c) => c.id === id) || null;
export const hasLive = (c) => !!(c && c.feeds && c.feeds.length);

/** Host yang perlu diizinkan di CSP bila aplikasi memakai CSP ketat: connect-src + media-src (HLS) dan frame-src (embed). */
const origins = (urls) => [...new Set(urls.map((u) => new URL(u).origin))];
export const CCTV_STREAM_HOSTS = origins(CCTV_ATCS.flatMap((c) => (c.feeds || []).flatMap((f) => f.streamUrls)));
export const CCTV_EMBED_HOSTS = origins(CCTV_ATCS.flatMap((c) => (c.feeds || []).map((f) => f.embedUrl)));
