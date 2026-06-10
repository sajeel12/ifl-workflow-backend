import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// Proof-image upload rules (DCI Implementer proof — onboarding AND offboarding):
//   • images only (JPG/PNG/GIF/WEBP)
//   • at most 5 files
//   • at most 1 MB per image
// 5 files × 1 MB caps the combined upload at 5 MB by construction, so no
// separate "total size" check is needed.
export const MAX_PROOF_FILES   = 5;
export const MAX_PROOF_BYTES    = 1 * 1024 * 1024;   // 1 MB per image
export const MAX_PROOF_TOTAL    = 5 * 1024 * 1024;   // 5 MB combined (5 × 1 MB)

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/proofs/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = uuidv4();
        cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const fileFilter = (req, file, cb) => {
    // Accept common image types only — proof must be a picture.
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        return cb(new Error('Only image files (JPG, PNG, GIF, WEBP) are allowed!'), false);
    }
    cb(null, true);
};

export const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: MAX_PROOF_BYTES, files: MAX_PROOF_FILES }
});

// Wrap upload.array('dciProof', 5) so multer's limit/filter errors render a
// clean message page instead of bubbling up as a raw 500. Used by both the
// onboarding and offboarding DCI-Implementer proof routes (regular form POSTs,
// so we render HTML rather than JSON).
export const uploadProofImages = (req, res, next) => {
    upload.array('dciProof', MAX_PROOF_FILES)(req, res, (err) => {
        if (!err) return next();

        let message;
        if (err.code === 'LIMIT_FILE_SIZE') {
            message = `Each proof image must be 1 MB or smaller (max ${MAX_PROOF_FILES} images, 5 MB total). Please compress or pick smaller images and try again.`;
        } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            message = `You can upload at most ${MAX_PROOF_FILES} proof images. Please remove some and try again.`;
        } else {
            message = err.message || 'The proof upload could not be processed.';
        }

        return res.status(400).render('pages/message', {
            title: 'Upload Error',
            heading: 'Proof upload rejected',
            titleClass: 'error',
            message
        });
    });
};
