// `node --import <this file>` is `node --import tsx` with tsx resolved from this package, so the caller's cwd doesn't
// matter. It never reaches into tsx's dist paths.
import "tsx";
