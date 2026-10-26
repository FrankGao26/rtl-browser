// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "sha256.h"

#include <cstring>

namespace rtl {
namespace {
constexpr uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
    0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
    0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
    0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
    0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
};

inline uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }
inline uint32_t ch(uint32_t x, uint32_t y, uint32_t z) { return (x & y) ^ (~x & z); }
inline uint32_t maj(uint32_t x, uint32_t y, uint32_t z) { return (x & y) ^ (x & z) ^ (y & z); }
inline uint32_t bsig0(uint32_t x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
inline uint32_t bsig1(uint32_t x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
inline uint32_t ssig0(uint32_t x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3); }
inline uint32_t ssig1(uint32_t x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10); }

void transform(uint32_t h[8], const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = (uint32_t(block[i * 4]) << 24) | (uint32_t(block[i * 4 + 1]) << 16) |
           (uint32_t(block[i * 4 + 2]) << 8) | uint32_t(block[i * 4 + 3]);
  }
  for (int i = 16; i < 64; i++) w[i] = ssig1(w[i - 2]) + w[i - 7] + ssig0(w[i - 15]) + w[i - 16];
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = hh + bsig1(e) + ch(e, f, g) + K[i] + w[i];
    uint32_t t2 = bsig0(a) + maj(a, b, c);
    hh = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d;
  h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}
} // namespace

std::array<uint8_t, 32> sha256(const void* data, size_t size) {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  const uint8_t* p = static_cast<const uint8_t*>(data);
  size_t full = size / 64;
  for (size_t i = 0; i < full; i++) transform(h, p + i * 64);

  uint8_t tail[128]{};
  size_t rem = size % 64;
  if (rem) std::memcpy(tail, p + full * 64, rem);
  tail[rem] = 0x80;
  size_t tailLen = rem < 56 ? 64 : 128;
  uint64_t bits = uint64_t(size) * 8;
  for (int i = 0; i < 8; i++) tail[tailLen - 1 - i] = uint8_t(bits >> (i * 8));
  transform(h, tail);
  if (tailLen == 128) transform(h, tail + 64);

  std::array<uint8_t, 32> out{};
  for (int i = 0; i < 8; i++) {
    out[i * 4] = uint8_t(h[i] >> 24);
    out[i * 4 + 1] = uint8_t(h[i] >> 16);
    out[i * 4 + 2] = uint8_t(h[i] >> 8);
    out[i * 4 + 3] = uint8_t(h[i]);
  }
  return out;
}

std::string sha256Hex(std::string_view data) {
  auto digest = sha256(data.data(), data.size());
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (uint8_t b : digest) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 15]);
  }
  return out;
}

std::string sha256Hex(const std::vector<uint8_t>& data) {
  auto digest = sha256(data.data(), data.size());
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (uint8_t b : digest) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 15]);
  }
  return out;
}
} // namespace rtl
