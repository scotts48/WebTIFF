/*
 * TypeScript TIFF Libary
 * Copyright 2015 NBT, Inc.
 * Released under the MIT license. See LICENSE.txt for details.
 */
/// <reference path="nbt-ccitt-g3g4.ts"/>
var NBT;
(function (NBT) {
    "use strict";
    /* tslint:disable:comment-format:check-space */
    /* tslint:disable:comment-format:check-lowercase */
    /* tslint:disable:no-trailing-whitespace */
    var TiffReader = (function () {
        function TiffReader(imageData) {
            this.bits = new DataView(imageData);
            this.position = 0;
            this.isLittleEndian = true;
            this.currentIFD = -1;
            this.nextIFD = -1;
            this.readHeader();
        }
        TiffReader.prototype.debugLog = function (message) {
            if (typeof window.console !== "undefined") {
                window.console.log(message);
            }
        };
        TiffReader.prototype.goToPage = function (pageIFD) {
            this.currentIFD = -1;
            this.nextIFD = pageIFD;
        };
        TiffReader.prototype.readPage = function () {
            this.page = null;
            // are we at the end of the page chain?
            if (this.nextIFD <= 0) {
                return false;
            }
            if (this.currentIFD !== -1 && this.nextIFD <= this.currentIFD) {
                throw "Cyclic data detected!";
            }
            // move to the next IFD location...This is either set
            // after we read the file header or at the end of reading
            // the current IFD in preparation for the next one...
            this.position = this.nextIFD;
            this.currentIFD = this.nextIFD;
            this.page = this.readIFD();
            return true;
        };
        TiffReader.prototype.internalDecompress = function (pixels) {
            if (pixels.width !== this.page.imageWidth) {
                throw "pixels.width does not match expected width " + this.page.imageWidth;
            }
            if (pixels.height !== this.page.imageHeight) {
                throw "pixels.height does not match expected height " + this.page.imageHeight;
            }
            switch (this.page.compressionType) {
                case TiffHelper.compression_CCITT_G4:
                    if (NBT.G3G4Decoder === undefined) {
                        throw "CCITT_G4 compression module not loaded";
                    }
                    else {
                        var rowsPerStrip = this.page.rowsPerStrip;
                        var stripOffsets = this.page.stripOffsets;
                        var stripByteCounts = this.page.stripByteCounts;
                        if (rowsPerStrip === 0) {
                            rowsPerStrip = pixels.height;
                        }
                        if (stripOffsets.length !== stripByteCounts.length) {
                            throw "Invalid Image Data: Strip Offset Count <> Strip Byte Count";
                        }
                        // set up our decoder from the tiff tag information
                        var row = 0;
                        var decoder = new NBT.G3G4Decoder();
                        decoder.imageWidth = pixels.width;
                        decoder.imageHeight = pixels.height;
                        decoder.fillOrder = this.page.fillOrder;
                        decoder.whiteIsZero = (this.page.photometricInterpretation === TiffHelper.photometric_WhiteIsZero);
                        for (var si = 0; si < stripOffsets.length; si++) {
                            var encodedBits = new DataView(this.bits.buffer, stripOffsets[si], stripByteCounts[si]);
                            decoder.decodeG4(encodedBits, pixels, row);
                            row += rowsPerStrip;
                        }
                    }
                    break;
                default:
                    throw ("Unsupported compression type: '" + this.page.compressionType + "'");
            }
            return pixels;
        };
        TiffReader.prototype.internalDecompressToCanvas = function (canvas) {
            var ctx = canvas.getContext("2d");
            ctx.font = "24pt sans-serif";
            ctx.textBaseline = "top";
            ctx.clearRect(0, 0, this.page.imageWidth, this.page.imageHeight);
            var pixels = ctx.createImageData(this.page.imageWidth, this.page.imageHeight);
            try {
                this.internalDecompress(pixels);
                ctx.putImageData(pixels, 0, 0);
            }
            catch (err) {
                ctx.strokeRect(0, 0, this.page.imageWidth, this.page.imageHeight);
                ctx.fillText(err, 10, 10);
            }
        };
        TiffReader.prototype.decompressToImageData = function () {
            if (!this.page) {
                throw "No current page!";
            }
            var canvas = document.createElement("canvas");
            canvas.width = this.page.imageWidth;
            canvas.height = this.page.imageHeight;
            var ctx = canvas.getContext("2d");
            var pixels = ctx.createImageData(this.page.imageWidth, this.page.imageHeight);
            this.internalDecompress(pixels);
            return pixels;
        };
        TiffReader.prototype.decompressToImage = function (image) {
            if (!this.page) {
                throw "No current page!";
            }
            var canvas = document.createElement("canvas");
            canvas.width = this.page.imageWidth;
            canvas.height = this.page.imageHeight;
            this.internalDecompressToCanvas(canvas);
            image.src = canvas.toDataURL();
            return image;
        };
        TiffReader.prototype.decompressToCanvas = function (canvas) {
            if (!this.page) {
                throw "No current page!";
            }
            canvas.width = this.page.imageWidth;
            canvas.height = this.page.imageHeight;
            this.internalDecompressToCanvas(canvas);
        };
        TiffReader.prototype.readUInt8 = function () {
            var value = this.bits.getUint8(this.position);
            this.position += 1;
            return value;
        };
        TiffReader.prototype.readUInt16 = function () {
            var value = this.bits.getUint16(this.position, this.isLittleEndian);
            this.position += 2;
            return value;
        };
        TiffReader.prototype.readUInt32 = function () {
            var value = this.bits.getUint32(this.position, this.isLittleEndian);
            this.position += 4;
            return value;
        };
        TiffReader.prototype.readHeader = function () {
            // first two bytes are the magic number to indicate
            // byte order, II for little endian and MM for big endian
            var magicNumber = this.readUInt16();
            if (magicNumber === TiffHelper.bigEndian) {
                this.isLittleEndian = false;
            }
            else if (magicNumber === TiffHelper.littleEndian) {
                this.isLittleEndian = true;
            }
            else {
                throw "Invalid Tiff Header (Byte Order)";
            }
            // next two bytes should be our version number, which is
            // just a secondary check to make sure we got the right
            // byte order
            var verNumber = this.readUInt16();
            if (verNumber !== TiffHelper.versionNumber) {
                throw "Invalid Tiff Header (Version)";
            }
            this.nextIFD = this.readUInt32();
        };
        TiffReader.prototype.readIFD = function () {
            var page = new TiffPage();
            // start reading the IFD at the current position
            var fieldCount = this.readUInt16();
            for (var fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
                // add the tag data to the page
                var tag = this.readField();
                page.tags[tag.code] = tag;
            }
            this.nextIFD = this.readUInt32();
            return page;
        };
        TiffReader.prototype.readField = function () {
            var tag = new TiffTag();
            tag.code = this.readUInt16();
            tag.dataType = this.readUInt16();
            switch (tag.dataType) {
                case TiffHelper.dataType_BYTE:
                    tag.values = this.readTagByte();
                    break;
                case TiffHelper.dataType_ASCII:
                    tag.values = this.readTagASCII();
                    break;
                case TiffHelper.dataType_SHORT:
                    tag.values = this.readTagShort();
                    break;
                case TiffHelper.dataType_LONG:
                    tag.values = this.readTagLong();
                    break;
                case TiffHelper.dataType_RATIONAL:
                    tag.values = this.readTagRational();
                    break;
                default:
                    // skip over unknown field data type
                    this.position += 8;
                    this.debugLog("Field data type " + tag.dataType + " not implemented!");
            }
            return tag;
        };
        TiffReader.prototype.readTagByte = function () {
            var maxLocalCount = 4;
            var tagValueCount = this.readUInt32();
            var values = new Array(tagValueCount);
            if (tagValueCount > maxLocalCount) {
                var tagValueOffset = this.readUInt32();
                var savePosition = this.position;
                this.position = tagValueOffset;
                for (var i = 0; i < tagValueCount; i++) {
                    values[i] = this.readUInt8();
                }
                this.position = savePosition;
            }
            else {
                for (var j = 0; j < tagValueCount; j++) {
                    values[j] = this.readUInt8();
                }
                for (; j < maxLocalCount; j++) {
                    this.readUInt8();
                }
            }
            return values;
        };
        TiffReader.prototype.readTagASCII = function () {
            var maxLocalCount = 4;
            var tagValueCount = this.readUInt32();
            var value = "";
            if (tagValueCount > maxLocalCount) {
                var tagValueOffset = this.readUInt32();
                var savePosition = this.position;
                this.position = tagValueOffset;
                for (var i = 0; i < tagValueCount; i++) {
                    var ic = this.readUInt8();
                    // break on null terminator
                    if (ic === 0) {
                        break;
                    }
                    value += String.fromCharCode(ic);
                }
                this.position = savePosition;
            }
            else {
                for (var j = 0; j < tagValueCount; j++) {
                    var jc = this.readUInt8();
                    // break on null terminator
                    if (jc === 0) {
                        break;
                    }
                    value += String.fromCharCode(jc);
                }
                for (; j < maxLocalCount; j++) {
                    this.readUInt8();
                }
            }
            return value;
        };
        TiffReader.prototype.readTagShort = function () {
            var maxLocalCount = 2;
            var tagValueCount = this.readUInt32();
            var values = new Array(tagValueCount);
            if (tagValueCount > maxLocalCount) {
                var tagValueOffset = this.readUInt32();
                var savePosition = this.position;
                this.position = tagValueOffset;
                for (var i = 0; i < tagValueCount; i++) {
                    values[i] = this.readUInt16();
                }
                this.position = savePosition;
            }
            else {
                for (var j = 0; j < tagValueCount; j++) {
                    values[j] = this.readUInt16();
                }
                for (; j < maxLocalCount; j++) {
                    this.readUInt16();
                }
            }
            return values;
        };
        TiffReader.prototype.readTagLong = function () {
            var maxLocalCount = 1;
            var tagValueCount = this.readUInt32();
            var values = new Array(tagValueCount);
            if (tagValueCount > maxLocalCount) {
                var tagValueOffset = this.readUInt32();
                var savePosition = this.position;
                this.position = tagValueOffset;
                for (var i = 0; i < tagValueCount; i++) {
                    values[i] = this.readUInt32();
                }
                this.position = savePosition;
            }
            else {
                for (var j = 0; j < tagValueCount; j++) {
                    values[j] = this.readUInt32();
                }
                for (; j < maxLocalCount; j++) {
                    this.readUInt32();
                }
            }
            return values;
        };
        TiffReader.prototype.readTagRational = function () {
            var tagValueCount = this.readUInt32();
            var values = new Array(tagValueCount);
            // nothing stored local, go to the offset...
            var tagValueOffset = this.readUInt32();
            var savePosition = this.position;
            this.position = tagValueOffset;
            for (var i = 0; i < tagValueCount; i++) {
                var rat = new TiffRational();
                rat.numerator = this.readUInt32();
                rat.denominator = this.readUInt32();
                values[i] = rat;
            }
            this.position = savePosition;
            return values;
        };
        return TiffReader;
    })();
    NBT.TiffReader = TiffReader;
    var TiffTag = (function () {
        function TiffTag() {
        }
        return TiffTag;
    })();
    var TiffRational = (function () {
        function TiffRational() {
        }
        return TiffRational;
    })();
    NBT.TiffRational = TiffRational;
    var TiffPage = (function () {
        function TiffPage() {
            this.tags = {};
        }
        Object.defineProperty(TiffPage.prototype, "compressionType", {
            // compression algorithm of the image
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_CompressiongType, 0);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "imageWidth", {
            // width (in pixels) of the image
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_ImageWidth, 0);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "imageHeight", {
            // height (in pixels) of the image
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_ImageLength, 0);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "dpiX", {
            // horizontal DPI for the image
            get: function () {
                var resX = this.getFirstTagValue(TiffHelper.tag_XResolution, null);
                if (resX == null) {
                    return 0;
                }
                var resUnit = this.getFirstTagValue(TiffHelper.tag_ResolutionUnit, TiffHelper.resolutionUnit_Inch);
                switch (resUnit) {
                    case TiffHelper.resolutionUnit_Centimeter:
                        return (resX.numerator / resX.denominator) * 2.54;
                    default:
                        return (resX.numerator / resX.denominator);
                }
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "dpiY", {
            // veritical DPI for the image
            get: function () {
                var resY = this.getFirstTagValue(TiffHelper.tag_YResolution, null);
                if (resY == null) {
                    return 0;
                }
                var resUnit = this.getFirstTagValue(TiffHelper.tag_ResolutionUnit, TiffHelper.resolutionUnit_Inch);
                switch (resUnit) {
                    case TiffHelper.resolutionUnit_Centimeter:
                        return (resY.numerator / resY.denominator) * 2.54;
                    default:
                        return (resY.numerator / resY.denominator);
                }
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "bitsPerPixel", {
            get: function () {
                var bitsPerSample = this.getFirstTagValue(TiffHelper.tag_BitsPerSample, 1);
                var samplesPerPixel = this.getFirstTagValue(TiffHelper.tag_SamplesPerPixel, 1);
                return bitsPerSample * samplesPerPixel;
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "fillOrder", {
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_FillOrder, TiffHelper.fillOrder_MSBtoLSB);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "photometricInterpretation", {
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_PhotometricInterpretation, TiffHelper.photometric_WhiteIsZero);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "stripOffsets", {
            get: function () {
                return this.getTagValues(TiffHelper.tag_StripOffsets, []);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "stripByteCounts", {
            get: function () {
                return this.getTagValues(TiffHelper.tag_StripByteCounts, []);
            },
            enumerable: true,
            configurable: true
        });
        Object.defineProperty(TiffPage.prototype, "rowsPerStrip", {
            get: function () {
                return this.getFirstTagValue(TiffHelper.tag_RowsPerStrip, 0);
            },
            enumerable: true,
            configurable: true
        });
        TiffPage.prototype.getFirstTagValue = function (tagCode, defaultValue) {
            var tag = this.tags[tagCode];
            if (tag) {
                return tag.values[0];
            }
            else {
                return defaultValue;
            }
        };
        TiffPage.prototype.getTagValues = function (tagCode, defaultValue) {
            var tag = this.tags[tagCode];
            if (tag) {
                return tag.values;
            }
            else {
                return defaultValue;
            }
        };
        return TiffPage;
    })();
    NBT.TiffPage = TiffPage;
    var TiffHelper = (function () {
        function TiffHelper() {
        }
        // check the provided buffer to see if it looks and smells like a TIFF
        TiffHelper.prototype.isValidTiff = function (imageData) {
            var position = 0;
            var bits = new DataView(imageData);
            // first two bytes are the magic number to indicate
            // byte order, II for little endian and MM for big endian
            var magicNumber = bits.getUint16(position);
            position += 2;
            var isLittleEndian = true;
            if (magicNumber === TiffHelper.bigEndian) {
                isLittleEndian = false;
            }
            else if (magicNumber === TiffHelper.littleEndian) {
                isLittleEndian = true;
            }
            else {
                return false;
            }
            // next two bytes should be our version number, which is
            // just a secondary check to make sure we got the right
            // byte order
            var verNumber = bits.getUint16(position, isLittleEndian);
            position += 2;
            if (verNumber !== TiffHelper.versionNumber) {
                return false;
            }
            return true;
        };
        // magic Number values to indicate endian-ness
        TiffHelper.bigEndian = 0x4d4d;
        TiffHelper.littleEndian = 0x4949;
        // expected value in header to confirm endian-ness
        TiffHelper.versionNumber = 42;
        // possible data types for IFD fields
        TiffHelper.dataType_BYTE = 1;
        TiffHelper.dataType_ASCII = 2;
        TiffHelper.dataType_SHORT = 3;
        TiffHelper.dataType_LONG = 4;
        TiffHelper.dataType_RATIONAL = 5;
        TiffHelper.dataType_SBYTE = 6;
        TiffHelper.dataType_UNDEFINED = 7;
        TiffHelper.dataType_SSHORT = 8;
        TiffHelper.dataType_SRATIONAL = 10;
        TiffHelper.dataType_FLOAT = 11;
        TiffHelper.dataType_DOUBLE = 12;
        TiffHelper.compression_Uncompressed = 1;
        TiffHelper.compression_CCITT_RLE = 2;
        TiffHelper.compression_CCITT_G3 = 3;
        TiffHelper.compression_CCITT_G4 = 4;
        TiffHelper.compression_LZW = 5;
        TiffHelper.compression_OldJPEG = 5;
        TiffHelper.compression_JPEG = 6;
        TiffHelper.compression_Deflate = 7;
        TiffHelper.compression_NeXT = 32766;
        TiffHelper.compression_CCITT_RLEW = 32771;
        TiffHelper.compression_PackBits = 32773;
        TiffHelper.resolutionUnit_None = 1;
        TiffHelper.resolutionUnit_Inch = 2;
        TiffHelper.resolutionUnit_Centimeter = 3;
        // order in which we handle the bits within a byte
        TiffHelper.fillOrder_MSBtoLSB = 1;
        TiffHelper.fillOrder_LSBtoMSB = 2;
        TiffHelper.photometric_WhiteIsZero = 0;
        TiffHelper.photometric_BlackIsZero = 1;
        TiffHelper.photometric_RGB = 2;
        TiffHelper.photometric_RGBPalette = 3;
        TiffHelper.photometric_TransparencyMask = 4;
        TiffHelper.photometric_CMYK = 5;
        TiffHelper.photometric_YCbCr = 6;
        TiffHelper.photometric_CIELab = 8;
        TiffHelper.photometric_ICCLab = 9;
        TiffHelper.tag_CompressiongType = 0x0103;
        TiffHelper.tag_ImageLength = 0x0101;
        TiffHelper.tag_ImageWidth = 0x0100;
        TiffHelper.tag_XResolution = 0x011A;
        TiffHelper.tag_YResolution = 0x011B;
        TiffHelper.tag_ResolutionUnit = 0x0128;
        TiffHelper.tag_BitsPerSample = 0x0102;
        TiffHelper.tag_SamplesPerPixel = 0x0115;
        TiffHelper.tag_PhotometricInterpretation = 0x0106;
        TiffHelper.tag_FillOrder = 0x010A;
        TiffHelper.tag_StripOffsets = 0x0111;
        TiffHelper.tag_RowsPerStrip = 0x0116;
        TiffHelper.tag_StripByteCounts = 0x0117;
        TiffHelper.tagNames = {
            // TIFF Baseline
            0x00FE: "NewSubfileType",
            0x00FF: "SubfileType",
            0x0100: "ImageWidth",
            0x0101: "ImageLength",
            0x0102: "BitsPerSample",
            0x0103: "Compression",
            0x0106: "PhotometricInterpretation",
            0x0107: "Threshholding",
            0x0108: "CellWidth",
            0x0109: "CellLength",
            0x010A: "FillOrder",
            0x010E: "ImageDescription",
            0x010F: "Make",
            0x0110: "Model",
            0x0111: "StripOffsets",
            0x0112: "Orientation",
            0x0115: "SamplesPerPixel",
            0x0116: "RowsPerStrip",
            0x0117: "StripByteCounts",
            0x0118: "MinSampleValue",
            0x0119: "MaxSampleValue",
            0x011A: "XResolution",
            0x011B: "YResolution",
            0x011C: "PlanarConfiguration",
            0x0120: "FreeOffsets",
            0x0121: "FreeByteCounts",
            0x0122: "GrayResponseUnit",
            0x0123: "GrayResponseCurve",
            0x0128: "ResolutionUnit",
            0x0131: "Software",
            0x0132: "DateTime",
            0x013B: "Artist",
            0x013C: "HostComputer",
            0x0140: "ColorMap",
            0x0152: "ExtraSamples",
            0x8298: "Copyright",
            // TIFF Extended
            0x010D: "DocumentName",
            0x011D: "PageName",
            0x011E: "XPosition",
            0x011F: "YPosition",
            0x0124: "T4Options",
            0x0125: "T6Options",
            0x0129: "PageNumber",
            0x012D: "TransferFunction",
            0x013D: "Predictor",
            0x013E: "WhitePoint",
            0x013F: "PrimaryChromaticities",
            0x0141: "HalftoneHints",
            0x0142: "TileWidth",
            0x0143: "TileLength",
            0x0144: "TileOffsets",
            0x0145: "TileByteCounts",
            0x0146: "BadFaxLines",
            0x0147: "CleanFaxData",
            0x0148: "ConsecutiveBadFaxLines",
            0x014A: "SubIFDs",
            0x0150: "DotRange",
            0x0153: "SampleFormat",
            0x0157: "ClipPath",
            0x0158: "XClipPathUnits",
            0x0159: "YClipPathUnits",
            0x015A: "Indexed",
            0x015B: "JPEGTables",
            0x01B1: "Decode",
            0x01B2: "DefaultImageColor",
            0x0211: "YCbCrCoefficients",
            0x0212: "YCbCrSubSampling",
            0x0213: "YCbCrPositioning",
            0x0214: "ReferenceBlackWhite",
            0x022F: "StripRowCounts",
            // EXIF
            0x829A: "ExposureTime",
            0x829D: "FNumber",
            0x8769: "Exif IFD",
            0x9000: "ExifVersion",
            0x9003: "DateTimeOriginal",
            0x9004: "DateTimeDigitized",
            0x9201: "ShutterSpeedValue",
            0x9202: "ApertureValue",
            0x9208: "LightSource",
            0x9209: "Flash",
            0x927C: "MakerNote",
            0x9286: "UserComment",
            0xA001: "ColorSpace",
            0xA000: "FlashpixVersion",
            0xA300: "FileSource",
            0xA420: "ImageUniqueID",
            // IPTC
            0x83BB: "IPTC",
            // ICC
            0x8773: "ICC Profile",
            // XMP
            0x02BC: "XMP",
            // GDAL
            0xA480: "GDAL_METADATA",
            0xA481: "GDAL_NODATA",
            // Photoshop
            0x8649: "Photoshop"
        };
        return TiffHelper;
    })();
    NBT.TiffHelper = TiffHelper;
})(NBT || (NBT = {}));
//# sourceMappingURL=nbt-tiff.js.map