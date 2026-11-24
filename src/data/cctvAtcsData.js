// src/data/cctvAtcsData.js
// Dataset statis titik CCTV ATCS Jabodetabek + Jawa Barat. Menggantikan query Overpass/OSM lama.
//
// Field tiap titik:
//   id, nama, wilayah (label tampilan), grup (kunci filter peta), lat, lng,
//   streamUrl  : URL .m3u8 langsung, atau null bila belum diketahui (pemutar otomatis menampilkan tombol portal)
//   portalUrl  : halaman resmi ATCS/RTTMC terkait
//   sumber     : pengelola/penyedia titik
//   streamStatus:
//     "pola-flussonic" = URL disusun dari pola server Bali Tower (Flussonic: /<nama-stream>/index.m3u8).
//                        Nama stream berasal dari tautan embed.html yang dipublikasikan; BELUM diuji dari sini.
//     "belum-ada"      = URL .m3u8 belum diketahui (streamUrl null).
//
// CATATAN PENTING
//  - Koordinat adalah perkiraan lokasi simpang/kawasan (bukan koordinat resmi kamera). Sesuaikan bila perlu.
//  - Banyak server CCTV pemerintah memblokir pemakaian lintas-situs (CORS) atau mengubah alamatnya sewaktu-waktu.
//    Karena itu CctvPlayerModal selalu menyediakan tombol portal resmi + pencarian sebagai cadangan.
//  - Cara mengisi streamUrl yang valid: buka halaman portal di browser desktop -> DevTools -> Network -> filter "m3u8"
//    -> salin URL playlist-nya ke field streamUrl dan ubah streamStatus menjadi "terverifikasi".

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

// Bali Tower memakai Flussonic: halaman /<stream>/embed.html berpasangan dengan /<stream>/index.m3u8.
const BT_HOST = "https://cctv.balitower.co.id";
const baliTowerHls = (stream) => `${BT_HOST}/${stream}/index.m3u8`;
const baliTowerPortal = (stream) => `${BT_HOST}/${stream}/embed.html?proto=hls`;

const bt = (id, nama, lat, lng, stream, wilayah = "Jakarta") => ({
  id, nama, wilayah, grup: "jakarta", lat, lng,
  streamUrl: baliTowerHls(stream),
  portalUrl: baliTowerPortal(stream),
  sumber: "Jakarta Smart City / Bali Tower",
  streamStatus: "pola-flussonic",
});

export const CCTV_ATCS = [
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
  {
    id: "jkt-atcs-dishub",
    nama: "ATCS Dishub DKI (peta kamera)",
    wilayah: "Jakarta Pusat",
    grup: "jakarta",
    lat: -6.1950, lng: 106.8230, // Bundaran HI (titik acuan portal)
    streamUrl: null,
    portalUrl: PORTAL.jakartaAtcs,
    sumber: "ATCS Dishub DKI Jakarta",
    streamStatus: "belum-ada",
  },

  // ===== Depok =====
  {
    id: "dpk-margonda-city-center",
    nama: "Margonda Raya (Depok City Center)",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3737, lng: 106.8322,
    streamUrl: null,
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  },
  {
    id: "dpk-terminal",
    nama: "Terminal Depok / Simpang Margonda-Juanda",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3919, lng: 106.8238,
    streamUrl: null,
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  },
  {
    id: "dpk-lenteng-agung",
    nama: "Perbatasan Lenteng Agung - Depok",
    wilayah: "Kota Depok",
    grup: "depok",
    lat: -6.3300, lng: 106.8346,
    streamUrl: null,
    portalUrl: PORTAL.depok,
    sumber: "ATCS Dishub Kota Depok (via agregator)",
    streamStatus: "belum-ada",
  },

  // ===== Bandung (ATCS Dishub + Pelindung) =====
  {
    id: "bdg-alun-alun",
    nama: "Alun-Alun Bandung",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9218, lng: 107.6071,
    streamUrl: null,
    portalUrl: PORTAL.bandungPelindung,
    sumber: "Pelindung Kota Bandung",
    streamStatus: "belum-ada",
  },
  {
    id: "bdg-asia-afrika",
    nama: "Jl. Asia Afrika",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9210, lng: 107.6097,
    streamUrl: null,
    portalUrl: PORTAL.bandungAtcs,
    sumber: "ATCS Dishub Kota Bandung",
    streamStatus: "belum-ada",
  },
  {
    id: "bdg-gedung-sate",
    nama: "Gedung Sate / Jl. Diponegoro",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.9025, lng: 107.6186,
    streamUrl: null,
    portalUrl: PORTAL.bandungAtcs,
    sumber: "ATCS Dishub Kota Bandung",
    streamStatus: "belum-ada",
  },
  {
    id: "bdg-pasteur",
    nama: "Simpang Pasteur",
    wilayah: "Kota Bandung",
    grup: "bandung-cianjur",
    lat: -6.8977, lng: 107.5946,
    streamUrl: null,
    portalUrl: PORTAL.bandungPelindung,
    sumber: "Pelindung Kota Bandung",
    streamStatus: "belum-ada",
  },

  // ===== Jalur Puncak - Cianjur (RTTMC Kemenhub) =====
  {
    id: "pck-gadog",
    nama: "Simpang Gadog (Puncak)",
    wilayah: "Kab. Bogor",
    grup: "bandung-cianjur",
    lat: -6.6567, lng: 106.8636,
    streamUrl: null,
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  },
  {
    id: "pck-cisarua",
    nama: "Cisarua (Puncak)",
    wilayah: "Kab. Bogor",
    grup: "bandung-cianjur",
    lat: -6.6813, lng: 106.9400,
    streamUrl: null,
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  },
  {
    id: "pck-puncak-pass",
    nama: "Puncak Pass",
    wilayah: "Kab. Bogor / Cianjur",
    grup: "bandung-cianjur",
    lat: -6.7035, lng: 106.9990,
    streamUrl: null,
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  },
  {
    id: "cjr-cipanas",
    nama: "Cipanas",
    wilayah: "Kab. Cianjur",
    grup: "bandung-cianjur",
    lat: -6.7494, lng: 107.0293,
    streamUrl: null,
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  },
  {
    id: "cjr-kota",
    nama: "Cianjur Kota",
    wilayah: "Kab. Cianjur",
    grup: "bandung-cianjur",
    lat: -6.8200, lng: 107.1430,
    streamUrl: null,
    portalUrl: PORTAL.rttmc,
    sumber: "RTTMC Kemenhub",
    streamStatus: "belum-ada",
  },
];

export const filterCctv = (grup) => (!grup || grup === "semua" ? CCTV_ATCS : CCTV_ATCS.filter((c) => c.grup === grup));
export const findCctv = (id) => CCTV_ATCS.find((c) => c.id === id) || null;

/** Hanya host stream yang perlu diizinkan di CSP (connect-src + media-src) bila aplikasi memakai CSP ketat. */
export const CCTV_STREAM_HOSTS = [...new Set(CCTV_ATCS.filter((c) => c.streamUrl).map((c) => new URL(c.streamUrl).origin))];
